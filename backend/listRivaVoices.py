"""Lista vozes do serviço Riva/NCVF (Chatterbox-Multilingual). Lê a chave do backend/.env."""
import os
import json
import sys

import riva.client
from riva.client.proto.riva_tts_pb2 import RivaSynthesisConfigRequest

ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")


def load_env():
    env = {}
    with open(ENV_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


env = load_env()
api_key = env.get("RIVA_API_KEY") or env.get("NVIDIA_API_KEY")
server = env.get("RIVA_SERVER", "grpc.nvcf.nvidia.com:443")
function_id = env.get("RIVA_TTS_FUNCTION_ID", "ddacc747-1269-4fab-bfd9-8f593dead106")

auth = riva.client.Auth(
    use_ssl=True,
    uri=server,
    metadata_args=[("function-id", function_id), ("authorization", f"Bearer {api_key}")],
)
service = riva.client.SpeechSynthesisService(auth)

config_response = service.stub.GetRivaSynthesisConfig(RivaSynthesisConfigRequest())
models = {}
for model_config in config_response.model_config:
    language_code = model_config.parameters["language_code"]
    voice_name = model_config.parameters["voice_name"]
    subvoices = [v.split(":")[0] for v in model_config.parameters["subvoices"].split(",")]
    full_names = [f"{voice_name}.{s}" for s in subvoices]
    models.setdefault(language_code, {"voices": []})["voices"].extend(full_names)

print(json.dumps(dict(sorted(models.items())), indent=2, ensure_ascii=False))
