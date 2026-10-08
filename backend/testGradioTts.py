from gradio_client import Client
import shutil
import os

try:
    print("Conectando ao Space 'elielsilva/tts_PTBR'...")
    client = Client("elielsilva/tts_PTBR")
    print("Conectado!")

    text = "Olá! Eu sou a Athina, sua assistente virtual NuovoPay. Como posso te ajudar hoje?"
    
    print("\nTestando geração via API /KOKORO_TTS_API...")
    result = client.predict(
        text,                  # text
        "Brazilian Portuguese", # language
        "pf_dora",             # voice
        1.0,                   # speed
        False,                 # translate_text
        False,                 # remove_silence
        False,                 # use_ffmpeg
        1.0,                   # pitch
        "Natural (Padrão)",    # preset
        True,                  # use_loudnorm
        api_name="/KOKORO_TTS_API"
    )
    print("Sucesso!")
    print("Resultado:", result)
    
    audio_path = result[0] if isinstance(result, tuple) or isinstance(result, list) else result
    if audio_path and os.path.exists(audio_path):
        dest = "debug_gradio_tts.wav"
        shutil.copy(audio_path, dest)
        print(f"✅ Áudio salvo com sucesso em: {dest}")

except Exception as e:
    print("❌ Erro durante o teste do Gradio:", str(e))
