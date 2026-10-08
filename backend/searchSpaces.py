from huggingface_hub import HfApi

try:
    api = HfApi()
    print("Buscando Spaces no Hugging Face Hub com a tag 'kokoro pt-br'...")
    spaces = api.list_spaces(search="kokoro pt-br", limit=15)
    
    print("\n=== SPACES LOCALIZADOS ===")
    for space in spaces:
        print(f"- Space ID: {space.id} (Likes: {space.likes}, Last Modified: {space.last_modified})")

except Exception as e:
    print("Erro ao buscar:", str(e))
