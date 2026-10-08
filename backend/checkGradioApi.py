from gradio_client import Client

try:
    print("Conectando ao Space 'Remsky/Kokoro-TTS-Zero'...")
    client = Client("Remsky/Kokoro-TTS-Zero")
    print("Conectado!")
    
    print("\n--- Informações do Cliente ---")
    print("Endpoints:", client.endpoints)
    
    # Vamos listar todos os componentes do Space para ver os inputs
    print("\n--- Componentes de UI ---")
    for i, component in enumerate(client.config.get("components", [])):
        print(f"Componente {i}: ID={component.get('id')}, Type={component.get('type')}, Label={component.get('label')}")
        
    print("\n--- Dependências de Eventos ---")
    for i, dep in enumerate(client.config.get("dependencies", [])):
        print(f"Dependência {i}: Inputs={dep.get('inputs')}, Outputs={dep.get('outputs')}, API Name={dep.get('api_name')}")

except Exception as e:
    print("Erro:", str(e))
