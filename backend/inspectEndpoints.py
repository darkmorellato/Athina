from gradio_client import Client

try:
    print("Conectando...")
    client = Client("hexgrad/Kokoro-TTS")
    print("Conectado!")
    
    # Exibe informações detalhadas de cada endpoint disponível
    for index, endpoint in client.endpoints.items():
        print(f"\n==================================================")
        print(f"Endpoint Index: {index}")
        print(f"API Name      : {endpoint.api_name}")
        print(f"Parameters    : {endpoint.parameters}")
        print(f"==================================================")

except Exception as e:
    print("Erro:", str(e))
