import os
from typing import List, Dict, Any
from azure.core.credentials import AzureKeyCredential
from azure.search.documents import SearchClient

class AzureCognitiveSearchRAG:
    def __init__(self):
        self.endpoint = os.environ.get("AZURE_SEARCH_ENDPOINT")
        self.index = os.environ.get("AZURE_SEARCH_INDEX")
        self.api_key = os.environ.get("AZURE_SEARCH_API_KEY")
        self.content_field = os.environ.get("AZURE_SEARCH_CONTENT_FIELD", "content")
        self.client = None
        if self.endpoint and self.index and self.api_key:
            self.client = SearchClient(
                endpoint=self.endpoint,
                index_name=self.index,
                credential=AzureKeyCredential(self.api_key)
            )

    def retrieve_documents(self, query: str, top: int = 3) -> List[Dict[str, Any]]:
        if not self.client:
            return []
        # Only select the content field and known StringCollection fields
        select_fields = [self.content_field, "people", "organizations", "locations", "keyphrases"]
        results = self.client.search(
            search_text=query,
            top=top,
            select=select_fields
        )
        docs = []
        for doc in results:
            docs.append({
                "content": doc.get(self.content_field, ""),
                "people": doc.get("people", []),
                "organizations": doc.get("organizations", []),
                "locations": doc.get("locations", []),
                "keyphrases": doc.get("keyphrases", [])
            })
        return docs
