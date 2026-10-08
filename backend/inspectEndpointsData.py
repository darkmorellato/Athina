from gradio_client import Client

try:
    client = Client("elielsilva/tts_PTBR")
    client.view_api()
except Exception as e:
    print("Erro:", str(e))
