import os
from azure_search_rag import AzureCognitiveSearchRAG

if __name__ == "__main__":
    # Ensure environment variables are loaded (if using dotenv in dev)
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass

    rag = AzureCognitiveSearchRAG()
    query = input("Enter a search query for Azure Cognitive Search: ")
    results = rag.retrieve_documents(query, top=3)

    print(f"\nTop {len(results)} results for query: '{query}'\n")
    for i, doc in enumerate(results, 1):
        print(f"Result {i}:")
        print(f"  Content       : {doc['content'][:300]}{'...' if len(doc['content']) > 300 else ''}")
        print(f"  People        : {', '.join(doc['people']) if doc['people'] else 'None'}")
        print(f"  Organizations : {', '.join(doc['organizations']) if doc['organizations'] else 'None'}")
        print(f"  Locations     : {', '.join(doc['locations']) if doc['locations'] else 'None'}")
        print(f"  Keyphrases    : {', '.join(doc['keyphrases']) if doc['keyphrases'] else 'None'}")
        print("-")
