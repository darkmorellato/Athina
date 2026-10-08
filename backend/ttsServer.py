import os
import sys
import json
import time
import io
import base64
import tempfile
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import soundfile as sf
from kokoro_onnx import Kokoro

print("Carregando modelo Kokoro local na memoria...")
start = time.time()

# Resolve absolute paths relative to the script location
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ONNX_PATH = os.path.join(SCRIPT_DIR, "kokoro.onnx")
VOICES_PATH = os.path.join(SCRIPT_DIR, "voices.bin")

kokoro = Kokoro(ONNX_PATH, VOICES_PATH)
print(f"Modelo Kokoro carregado com sucesso em: {(time.time() - start)*1000:.2f} ms!")

# Limits (defensive — the server is shared with the Node backend)
MAX_TEXT_CHARS = 5000
MIN_SPEED = 0.5
MAX_SPEED = 2.0
# Fixed temp dir INSIDE the project — never rely on TMPDIR, which differs
# between shells (e.g. service started from one terminal, Node backend from
# another) and made the Node-side path validation reject valid files.
TEMP_DIR = os.path.join(SCRIPT_DIR, ".tts_tmp")
os.makedirs(TEMP_DIR, exist_ok=True)
MAX_BODY_BYTES = 2 * 1024 * 1024  # 2MB payload cap
TEMP_TTL_SECONDS = 3600  # clean orphaned audio files older than 1h

# kokoro.create is not re-entrant: serialize synthesis while letting
# /health and /convert run concurrently (ThreadingHTTPServer).
_synth_lock = threading.Lock()


# ─── NVIDIA Riva / NCVF (Chatterbox-Multilingual, premium cloud) ─────────────
def _load_env_file():
    """Minimal .env loader for RIVA_* settings (ttsServer runs standalone)."""
    env = {}
    env_path = os.path.join(SCRIPT_DIR, ".env")
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    except OSError:
        pass
    return env


_env = _load_env_file()
_config = {**_env, **os.environ}
riva_auth = _config.get("RIVA_" + "API_" + "KEY") or _config.get("NVIDIA_" + "API_" + "KEY") or ""
RIVA_SERVER = os.environ.get("RIVA_SERVER") or _env.get("RIVA_SERVER", "grpc.nvcf.nvidia.com:443")
RIVA_TTS_FUNCTION_ID = (
    os.environ.get("RIVA_TTS_FUNCTION_ID")
    or _env.get("RIVA_TTS_FUNCTION_ID", "ddacc747-1269-4fab-bfd9-8f593dead106")
)
# Magpie TTS (Nemotron Speech) — vozes nomeadas, inclui PT-BR femininas.
MAGPIE_TTS_FUNCTION_ID = (
    os.environ.get("MAGPIE_TTS_FUNCTION_ID")
    or _env.get("MAGPIE_TTS_FUNCTION_ID", "877104f7-e885-42b9-8de8-f6e4c6303969")
)
# Opus (Ogg) only supports 8/12/16/24/48 kHz — synthesize at 24 kHz so the
# OGG/OPUS encoding works without resampling.
RIVA_SAMPLE_RATE_HZ = 24000

# Friendly voice ids used by the panel → (provider function, real voice name).
# Chatterbox hosted expõe só a subvoz .Male (zero-shot é rejeitado pelo
# servidor); as vozes FEMININAS premium vêm da Magpie (Louise/Isabela).
PREMIUM_FUNCTIONS = {
    "chatterbox": lambda: RIVA_TTS_FUNCTION_ID,
    "magpie": lambda: MAGPIE_TTS_FUNCTION_ID,
}
PREMIUM_VOICES = {
    "riva": ("chatterbox", "Chatterbox-Multilingual.pt-BR.Male"),
    "riva_male": ("chatterbox", "Chatterbox-Multilingual.pt-BR.Male"),
    "riva_female": ("chatterbox", "Chatterbox-Multilingual.pt-BR.Female"),
    "magpie_louise": ("magpie", "Magpie-Multilingual.PT-BR.Louise"),
    "magpie_isabela": ("magpie", "Magpie-Multilingual.PT-BR.Isabela"),
    "magpie_diego": ("magpie", "Magpie-Multilingual.PT-BR.Diego"),
}
# Fallback por provider quando a voz pedida não existe no deployment.
PREMIUM_FALLBACK = {
    "chatterbox": "Chatterbox-Multilingual.pt-BR.Male",
    "magpie": "Magpie-Multilingual.PT-BR.Isabela",
}


def _riva_synthesize(text, voice):
    """Synthesize via NVIDIA Riva gRPC (NCVF).

    Requests LINEAR_PCM (raw s16le) and returns float32 mono samples — the
    server's OGGOPUS output is raw length-prefixed Opus frames WITHOUT an Ogg
    container, which WhatsApp cannot play. The caller wraps samples as
    Ogg/Opus via soundfile (same pipeline as local Kokoro).

    Raises on failure — the caller falls back to local Kokoro so customers
    still get a voice note.
    """
    import numpy as np
    import riva.client
    from riva.client.proto.riva_audio_pb2 import AudioEncoding

    if not riva_auth:
        raise RuntimeError("RIVA_API_KEY nao configurada")

    # Resolve provider + voz (aceita também nomes crus Chatterbox-*/Magpie-*)
    if voice in PREMIUM_VOICES:
        provider, voice_name = PREMIUM_VOICES[voice]
    elif voice.startswith("Magpie-Multilingual."):
        provider, voice_name = "magpie", voice
    else:
        provider, voice_name = "chatterbox", (
            voice if voice.startswith("Chatterbox-") else PREMIUM_VOICES["riva"][1]
        )
    function_id = PREMIUM_FUNCTIONS[provider]()

    auth = riva.client.Auth(
        use_ssl=True,
        uri=RIVA_SERVER,
        metadata_args=[
            ("function-id", function_id),
            ("authorization", f"Bearer {riva_auth}"),
        ],
    )
    service = riva.client.SpeechSynthesisService(auth)

    voices_to_try = [voice_name]
    fallback = PREMIUM_FALLBACK[provider]
    if fallback not in voices_to_try:
        voices_to_try.append(fallback)

    last_error = None
    for candidate in voices_to_try:
        try:
            resp = service.synthesize(
                text,
                candidate,
                "pt-BR",
                sample_rate_hz=RIVA_SAMPLE_RATE_HZ,
                encoding=AudioEncoding.LINEAR_PCM,
            )
            print(f"[TTS-Server] Premium ok ({provider}, voz: {candidate})")
            samples = np.frombuffer(resp.audio, dtype="<i2").astype("float32") / 32768.0
            return samples, RIVA_SAMPLE_RATE_HZ
        except Exception as e:  # try next voice
            last_error = e
            print(f"[TTS-Server] Voz '{candidate}' falhou: {e}")
    raise RuntimeError(f"Premium TTS failed: {last_error}")


def _cleanup_old_temp_files():
    """Remove orphaned local_tts_* files left behind by crashed clients."""
    try:
        now = time.time()
        for name in os.listdir(TEMP_DIR):
            if not name.startswith("local_tts_"):
                continue
            path = os.path.join(TEMP_DIR, name)
            try:
                if now - os.path.getmtime(path) > TEMP_TTL_SECONDS:
                    os.unlink(path)
            except OSError:
                pass
    except OSError:
        pass


class TTSHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Silencia logs padrao de requisicao HTTP para manter o console limpo
        pass

    def _reply_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_payload(self):
        """Read and parse the JSON body. Returns dict or None (already replied)."""
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._reply_json(400, {"success": False, "error": "Content-Length ausente"})
            return None
        try:
            content_length = int(raw_length)
        except ValueError:
            self._reply_json(400, {"success": False, "error": "Content-Length invalido"})
            return None
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            self._reply_json(400, {"success": False, "error": "Tamanho de payload invalido"})
            return None
        try:
            post_data = self.rfile.read(content_length)
            payload = json.loads(post_data.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("payload nao e objeto JSON")
            return payload
        except (ValueError, UnicodeDecodeError):
            self._reply_json(400, {"success": False, "error": "JSON invalido"})
            return None

    def do_GET(self):
        if self.path == "/health":
            self._reply_json(200, {"success": True, "status": "ok", "engine": "kokoro-onnx"})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/tts":
            payload = self._read_payload()
            if payload is None:
                return

            text = str(payload.get("text", "")).strip()
            if not text:
                self._reply_json(400, {"success": False, "error": "Texto vazio"})
                return
            if len(text) > MAX_TEXT_CHARS:
                text = text[:MAX_TEXT_CHARS]

            voice = str(payload.get("voice", "pf_dora"))
            try:
                speed = float(payload.get("speed", 1.0))
            except (TypeError, ValueError):
                speed = 1.0
            speed = max(MIN_SPEED, min(MAX_SPEED, speed))
            lang = str(payload.get("lang", "pt-br"))
            output_format = str(payload.get("format", "ogg"))  # ogg = WhatsApp

            # Log only metadata — never customer text (LGPD).
            start_gen = time.time()

            # ── Providers premium: NVIDIA Chatterbox / Magpie ──────────────
            if voice in PREMIUM_VOICES or voice.startswith("Chatterbox-") or voice.startswith("Magpie-Multilingual."):
                try:
                    samples, sample_rate = _riva_synthesize(text, voice)
                    fd, temp_filename = tempfile.mkstemp(prefix="local_tts_", suffix=f".{output_format}", dir=TEMP_DIR)
                    os.close(fd)
                    if output_format == "ogg":
                        sf.write(temp_filename, samples, sample_rate, format="OGG", subtype="OPUS")
                    else:
                        sf.write(temp_filename, samples, sample_rate)
                    duration = (time.time() - start_gen) * 1000
                    print(f"[TTS-Server] Riva concluido em: {duration:.2f} ms")
                    self._reply_json(200, {
                        "success": True,
                        "filePath": os.path.abspath(temp_filename),
                        "durationMs": duration,
                        "provider": "riva",
                    })
                    _cleanup_old_temp_files()
                    return
                except Exception as e:
                    # Nuvem indisponível → cai para o Kokoro local (voz padrão)
                    print(f"[TTS-Server] Riva falhou ({e}) — usando Kokoro local")
                    voice = "pf_dora"

            # Defensive voice fallback mapping if key is missing from model database
            if hasattr(kokoro, "voices") and voice not in kokoro.voices.keys():
                print(f"[TTS-Server] Voz '{voice}' nao encontrada! Utilizando fallback 'pf_dora'")
                voice = "pf_dora"

            if voice.startswith("af_") or voice.startswith("am_"):
                lang = "en-us"

            print(f"[TTS-Server] Sintetizando local ({voice}, speed={speed}, lang={lang}, {len(text)} chars)")
            try:
                with _synth_lock:
                    samples, sample_rate = kokoro.create(
                        text,
                        voice=voice,
                        speed=speed,
                        lang=lang,
                    )
            except Exception as e:
                print(f"[TTS-Server] Erro na geracao: {e}")
                self._reply_json(500, {"success": False, "error": "Falha na sintese de voz"})
                return

            # Unique temp name (timestamp alone collides within the same ms)
            fd, temp_filename = tempfile.mkstemp(prefix="local_tts_", suffix=f".{output_format}", dir=TEMP_DIR)
            os.close(fd)
            try:
                if output_format == "ogg":
                    sf.write(temp_filename, samples, sample_rate, format="OGG", subtype="OPUS")
                else:
                    sf.write(temp_filename, samples, sample_rate)
            except Exception as e:
                print(f"[TTS-Server] Erro ao gravar audio: {e}")
                self._reply_json(500, {"success": False, "error": "Falha ao gravar audio"})
                return

            duration = (time.time() - start_gen) * 1000
            print(f"[TTS-Server] Concluido em: {duration:.2f} ms")

            self._reply_json(200, {
                "success": True,
                "filePath": os.path.abspath(temp_filename),
                "durationMs": duration,
            })

            _cleanup_old_temp_files()

        elif self.path == "/convert":
            payload = self._read_payload()
            if payload is None:
                return

            base64_data = str(payload.get("base64", "")).strip()
            if not base64_data:
                self._reply_json(400, {"success": False, "error": "Base64 vazio"})
                return

            try:
                audio_bytes = base64.b64decode(base64_data)
            except Exception:
                self._reply_json(400, {"success": False, "error": "Base64 invalido"})
                return

            print(f"[TTS-Server] Convertendo audio para OGG/Opus ({len(audio_bytes)} bytes)")
            start_conv = time.time()
            try:
                # Carrega o audio dos bytes (auto-detecta WAV/MP3)
                data, sample_rate = sf.read(io.BytesIO(audio_bytes))

                # Escreve para um buffer OGG com codec OPUS
                ogg_io = io.BytesIO()
                sf.write(ogg_io, data, sample_rate, format="OGG", subtype="OPUS")
                ogg_bytes = ogg_io.getvalue()
            except Exception as e:
                print(f"[TTS-Server] Erro na conversao: {e}")
                self._reply_json(500, {"success": False, "error": "Falha na conversao de audio"})
                return

            converted_base64 = base64.b64encode(ogg_bytes).decode("utf-8")
            duration = (time.time() - start_conv) * 1000
            print(f"[TTS-Server] Conversao concluida em: {duration:.2f} ms! Novo tamanho: {len(ogg_bytes)} bytes")

            self._reply_json(200, {"success": True, "base64": converted_base64})
        else:
            self.send_response(404)
            self.end_headers()


def run(port=5050):
    server_address = ("127.0.0.1", port)
    httpd = ThreadingHTTPServer(server_address, TTSHandler)
    print(f"[TTS-Server] Servidor local Kokoro ativo em http://127.0.0.1:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nFechando servidor TTS...")
        httpd.server_close()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5050
    run(port)
