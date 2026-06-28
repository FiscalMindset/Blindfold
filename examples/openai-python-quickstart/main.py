"""Blindfolded OpenAI call (Python) — with a proof this process never holds the key.

The only Blindfold-specific lines are base_url + api_key. The point of the
example is the proof: the local "key" is a sentinel, yet a real completion
succeeds because the real key lives in the T3 enclave behind the proxy.
"""
import os
from openai import OpenAI

local_key = os.environ.get("OPENAI_API_KEY", "__BLINDFOLD__")

# 1. Prove the real secret is NOT in this process.
if local_key != "__BLINDFOLD__":
    print("⚠  A real-looking key is in OPENAI_API_KEY — that defeats Blindfold. Seal it + use the sentinel.")
print(f'🔒 This process\'s api_key = "{local_key}"  (the real key is in the enclave)')

client = OpenAI(
    base_url=os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:8787/v1"),
    api_key=local_key,  # ← a sentinel, not a secret
)

# 2. Real call — the proxy substitutes the sealed key inside the enclave.
response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[
        {"role": "system", "content": "You are a concise assistant."},
        {"role": "user", "content": "Reply with exactly: 'Blindfold works.'"},
    ],
)

print(f"🤖 {response.choices[0].message.content}")
print("✅ Real completion succeeded with a key this process never held.")
