"""Smallest possible Blindfolded OpenAI call (Python)."""
import os
from openai import OpenAI

client = OpenAI(
    base_url=os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:8787/v1"),
    api_key=os.environ.get("OPENAI_API_KEY", "__BLINDFOLD__"),
)

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[
        {"role": "system", "content": "You are a concise assistant."},
        {"role": "user",   "content": "In one sentence, what is Terminal 3?"},
    ],
)

print(response.choices[0].message.content)
