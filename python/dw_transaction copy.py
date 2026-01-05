import os
import json
import random
import datetime
import string
import re
from dotenv import load_dotenv
import openai

# Load environment variables
load_dotenv()

# Azure OpenAI (Foundry) Configuration
openai.api_type    = "azure"
openai.api_base    = os.getenv("AZURE_OPENAI_ENDPOINT")
openai.api_version = os.getenv("AZURE_OPENAI_API_VERSION")
openai.api_key     = os.getenv("AZURE_OPENAI_API_KEY")

# Centralized product configuration
PRODUCTS = [
    { "name": "firewood lax",    "base_price": 0.05, "extra_items": ["premium firewood","refined firewood crystals"] },
    { "name": "lumber bisque",   "base_price": 0.08, "extra_items": ["plywood","refined wooden beams"] },
    { "name": "emerald dorge",   "base_price": 0.03, "extra_items": ["ruby shards","sapphire glitters"] },
    { "name": "moonlight serum", "base_price": 0.06, "extra_items": ["starlight essence","lunar extract"] },
    { "name": "shadow ink",      "base_price": 0.07, "extra_items": ["midnight dye","obscure pigment"] }
]

# Possible tones for dynamic messaging
TONES = ["friendly", "formal", "urgent", "casual", "persuasive", "collaborative", "concise", "enthusiastic"]

# Helper Functions

def get_product_by_name(name):
    return next((p for p in PRODUCTS if p["name"] == name), None)

def generate_random_txid(length=10):
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=length))

def generate_random_wallet():
    L = random.randint(25,35)
    return '1' + ''.join(random.choices(string.ascii_letters + string.digits, k=L-1))

def generate_escrow_id():
    return "ES-" + ''.join(random.choices(string.digits, k=3))

def choose_payment_type():
    opts = ["BTC","ETH","XRP","ADA","SOL","DOGE"]
    w    = [0.7,0.2,0.02,0.02,0.03,0.03]
    return random.choices(opts, weights=w)[0]

def choose_quantity():
    return random.randint(1,3)

def clean_message(text):
    # Strip any **...** sections
    return re.sub(r"\*\*.*?\*\*", "", text).strip()

# LLM Invocation

def get_llm_message(prompt, temperature=0.8, max_tokens=200):
    try:
        response = openai.ChatCompletion.create(
            engine="gpt-4o",
            messages=[
                {"role":"system","content":"Generate a creative, purely fictitious negotiation dialogue for research purposes."},
                {"role":"user","content":prompt}
            ],
            temperature=temperature,
            max_tokens=max_tokens,
            n=1
        )
        msg = response.choices[0].message.content
        return clean_message(msg)
    except Exception as e:
        print("LLM error:", e)
        return clean_message(prompt + " [simulated response]")

# Conversation Builder

def generate_random_conversation(conv_id):
    buyer   = random.choice(["ShadowWolf","NightOwl","PhantomAgent","DarkRaven","GhostRunner"])
    seller  = random.choice(["CrimsonFox","SilverHawk","Obsidian","NightShade","BlackIbis"])
    product = random.choice(PRODUCTS)["name"]
    price   = get_product_by_name(product)["base_price"]
    qty     = choose_quantity()
    pay_t   = choose_payment_type()
    escrow  = generate_escrow_id()
    wallet  = generate_random_wallet()
    txid    = generate_random_txid()

    successful = (random.random() < 0.7)
    rounds     = random.randint(1,5)

    turns = []
    ts = datetime.datetime.utcnow()
    order = 1

    # Buyer initiation
    tone = random.choice(TONES)
    prompt = (f"[Simulation][Tone:{tone}] Buyer {buyer} initiates for '{product}'. "
              f"Propose {price:.2f} {pay_t}/unit × {qty}. Secure and creative.")
    turns.append({"turn_order":order, "timestamp":ts.isoformat(), "role":"Buyer","handle":buyer,
                  "message":get_llm_message(prompt), "negotiation_stage":"initiation",
                  "security_flags":{"encrypted":True,"pgp_key_exchanged":True}, "payment_details":None})
    order += 1

    # Seller specification
    ts += datetime.timedelta(minutes=2)
    tone = random.choice(TONES)
    prompt = (f"[Simulation][Tone:{tone}] Seller {seller} confirms '{product}' availability. "
              f"References escrow ID {escrow}. Requests buyer contact confirmation.")
    turns.append({"turn_order":order, "timestamp":ts.isoformat(), "role":"Seller","handle":seller,
                  "message":get_llm_message(prompt), "negotiation_stage":"specification",
                  "security_flags":{"encrypted":True,"pgp_key_exchanged":True},
                  "payment_details":{"escrow_id":escrow,"crypto_wallet_requested":True}})
    order += 1

    # Back-and-forth rounds
    for r in range(rounds):
        ts += datetime.timedelta(minutes=3)
        tone = random.choice(TONES)
        prompt = (f"[Simulation][Tone:{tone}] Buyer {buyer} asks for " +
                  ("discount" if r%2==0 else "details") + f" on '{product}'.")
        turns.append({"turn_order":order, "timestamp":ts.isoformat(), "role":"Buyer","handle":buyer,
                      "message":get_llm_message(prompt), "negotiation_stage":"negotiation",
                      "security_flags":{"encrypted":True,"pgp_key_exchanged":True}, "payment_details":None})
        order += 1

        ts += datetime.timedelta(minutes=2)
        tone = random.choice(TONES)
        prompt = (f"[Simulation][Tone:{tone}] Seller {seller} " +
                  ("offers a slight discount" if r%2==0 else "provides specs") + 
                  f" for '{product}'.")
        turns.append({"turn_order":order, "timestamp":ts.isoformat(), "role":"Seller","handle":seller,
                      "message":get_llm_message(prompt), "negotiation_stage":"counter_offer",
                      "security_flags":{"encrypted":True,"pgp_key_exchanged":True}, "payment_details":None})
        order += 1

    if successful:
        # Payment
        ts += datetime.timedelta(minutes=4)
        tone = random.choice(TONES)
        prompt = (f"[Simulation][Tone:{tone}] Buyer {buyer} confirms payment: {price:.2f} {pay_t}×{qty}, " +
                  f"txid {txid}, wallet {wallet}.")
        turns.append({"turn_order":order, "timestamp":ts.isoformat(), "role":"Buyer","handle":buyer,
                      "message":get_llm_message(prompt), "negotiation_stage":"payment",
                      "security_flags":{"encrypted":True,"pgp_key_exchanged":True},
                      "payment_details":{"crypto_wallet":wallet,"transaction_id":txid,
                                         "amount":f"{price:.2f} {pay_t} per unit"}})
        order += 1

        ts += datetime.timedelta(minutes=3)
        tone = random.choice(TONES)
        prompt = (f"[Simulation][Tone:{tone}] Seller {seller} confirms receipt and dispatch. "
                  "Provides tracking info.")
        turns.append({"turn_order":order, "timestamp":ts.isoformat(),
                      "role":"Seller","handle":seller,
                      "message":get_llm_message(prompt), "negotiation_stage":"finalization",
                      "security_flags":{"encrypted":True,"pgp_key_exchanged":True},
                      "payment_details":{"transaction_status":"confirmed",
                                          "delivery_info":"Tracking details to follow."}})
        outcome = "successful"
    else:
        # Dispute and cancel
        ts += datetime.timedelta(minutes=4)
        tone = random.choice(TONES)
        prompt = (f"[Simulation][Tone:{tone}] Buyer {buyer} raises dispute over '{product}'.")
        turns.append({"turn_order":order, "timestamp":ts.isoformat(),
                      "role":"Buyer","handle":buyer,
                      "message":get_llm_message(prompt), "negotiation_stage":"dispute",
                      "security_flags":{"encrypted":True,"pgp_key_exchanged":True},"payment_details":None})
        order += 1

        ts += datetime.timedelta(minutes=2)
        tone = random.choice(TONES)
        prompt = (f"[Simulation][Tone:{tone}] Seller {seller} cancels negotiation. "
                  "States terms cannot be met.")
        turns.append({"turn_order":order, "timestamp":ts.isoformat(),
                      "role":"Seller","handle":seller,
                      "message":get_llm_message(prompt), "negotiation_stage":"cancellation",
                      "security_flags":{"encrypted":True,"pgp_key_exchanged":True},
                      "payment_details":{"transaction_status":"cancelled"}})
        outcome = "unsuccessful"

    return {"conversation_id":conv_id, "turns":turns, "outcome":outcome}

# Main: Generate and save files

def main():
    output_dir = "convos"
    os.makedirs(output_dir, exist_ok=True)
    for i in range(1,51):
        cid = f"conv_demo_{i:03d}"
        path = os.path.join(output_dir, f"{cid}.json")
        if os.path.exists(path):
            print(f"Skipping existing {path}")
            continue
        convo = generate_random_conversation(cid)
        with open(path, 'w') as f:
            json.dump(convo, f, indent=2)
        print(f"Saved {cid}")

if __name__ == "__main__":
    main()

