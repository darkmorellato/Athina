from gradio_client import Client

try:
    print("Conectando ao Hugging Face Space hexgrad/Kokoro-TTS...")
    client = Client("hexgrad/Kokoro-TTS")
    print("Conectado com sucesso!\n")
    print("=== API ENDPOINTS DISPONÍVEIS ===")
    client.view_api()
except Exception as e:
    print("Erro ao conectar:", str(e))
