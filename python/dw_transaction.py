import openai
import json
import random
import datetime
import string
import os
from dotenv import load_dotenv
import re 


# Load environment variables from .env file
load_dotenv()
# -------------------------------
# Azure OpenAI (Foundry) Configuration
# -------------------------------
# -------------------------------
# Azure OpenAI (Foundry) Configuration
# -------------------------------
openai.api_type = "azure"
openai.api_base = os.getenv("AZURE_OPENAI_ENDPOINT", "https://YOUR_AZURE_RESOURCE_NAME.openai.azure.com")
openai.api_version = os.getenv("AZURE_OPENAI_API_VERSION", "2023-05-15")
openai.api_key = os.getenv("AZURE_OPENAI_API_KEY", "YOUR_AZURE_API_KEY_HERE")

# -------------------------------
# Helper Functions for IDs & Payment
# -------------------------------
def generate_random_txid(length=10):
    """Generate a random transaction ID with letters and digits."""
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=length))

def generate_random_wallet():
    """Simulate a crypto wallet address (rough mimic of common crypto wallets)."""
    length = random.randint(25, 35)
    return '1' + ''.join(random.choices(string.ascii_letters + string.digits, k=length-1))

def generate_escrow_id():
    """Generate a random escrow ID."""
    return "ES-" + ''.join(random.choices(string.digits, k=3))

def generate_pgp_key(handle, year="2025"):
    """Generate a PGP key string based on the handle."""
    return f"{handle[:2].upper()}_KEY_{year}"

def random_price(product):
    """Determine a product’s price based on its type."""
    base_prices = {
        "firewood lax": 0.05,
        "lumber bisque": 0.08,
        "emerald dorge": 0.03,
        "moonlight slick": 0.06,
        "shadow ink": 0.07
    }
    return base_prices.get(product, 0.05)

def choose_payment_type():
    """Randomly choose a payment type with BTC and ETH more common than others."""
    payment_options = ["BTC", "ETH", "XRP", "ADA", "SOL", "DOGE"]
    weights = [0.7, 0.2, 0.02, 0.02, 0.03, 0.03]  # adjust weights as desired
    return random.choices(payment_options, weights=weights, k=1)[0]

def choose_quantity():
    """Choose a quantity (1 to 3 units)."""
    return random.randint(1, 3)

# Centralized product configuration
PRODUCTS = [
    {
        "name": "firewood lax",
        "full_name": "firewood lax",
        "base_price": 0.05,
        "extra_items": ["premium firewood", "refined firewood crystals"]
    },
    {
        "name": "lumber bisque", 
        "full_name": "lumber bisque",
        "base_price": 0.08,
        "extra_items": ["plywood", "refined wooden beams"]
    },
    {
        "name": "emerald dorge",
        "full_name": "emerald dorge", 
        "base_price": 0.03,
        "extra_items": ["ruby shards", "sapphire glitters"]
    },
    {
        "name": "moonlight serum",
        "full_name": "moonlight slick",
        "base_price": 0.06,
        "extra_items": ["starlight essence", "lunar extract"]
    },
    {
        "name": "shadow ink",
        "full_name": "shadow ink",
        "base_price": 0.07,
        "extra_items": ["midnight dye", "obscure pigment"]
    }
]

def get_product_by_name(product_name):
    """Get product configuration by name."""
    for product in PRODUCTS:
        if product["name"] == product_name:
            return product
    return None

# -------------------------------
# LLM Integration Using Azure Foundry
# -------------------------------
def get_llm_message(prompt, temperature=0.9, max_tokens=150):
    """
    Call GPT-4 ovia Azure OpenAI (Foundry) to generate a message variation.
    The prompt has been modified to be generic and clearly for educational research simulation purposes.
    """
    try:
        response = openai.ChatCompletion.create(
            engine="gpt-4o",  # Or the name of your deployed model endpoint in Azure
            messages=[
                {"role": "system", "content": (
                    "You are a creative assistant tasked with generating educational and purely fictitious negotiation dialogues. "
                    "All outputs are for research simulation purposes only and should be neutral and generic without real-world implications."
                )},
                {"role": "user", "content": prompt}
            ],
            temperature=temperature,
            max_tokens=max_tokens,
            n=1
        )
        message = response["choices"][0]["message"]["content"].strip()
        message = re.sub(r"\*\*.*?\*\*", "", message).strip()
    
    except Exception as e:
        print(f"LLM call error: {e}")
        print(prompt)
        message = prompt + " [simulated variant]"
    return message

def generate_role_message(role, stage, buyer, seller, product, price, escrow_id=None, wallet=None, txid=None, payment_type="BTC", quantity=1):
    """
    Generate a negotiation message using GPT-4 based on role and stage.
    The prompts now emphasize the educational research and simulation context.
    """
    pgp_key = generate_pgp_key(buyer)
    base_prompt = ""
    
    if role.lower() == "buyer":
        if stage == "initiation":
            base_prompt = (
                f"[Simulation] You are a buyer named {buyer} initiating a fictitious negotiation dialogue "
                f"to inquire about a product called '{product}'. Propose a price of {price:.2f} {payment_type} per unit for {quantity} unit(s), "
                "and mention that you are using secure communication (all details here are simulated). "
                "Keep the language natural and creative."
            )
        elif stage == "negotiation":
            base_prompt = (
                f"[Simulation] You are buyer {buyer} following up on your inquiry for '{product}'. "
                "Ask for further clarification on the product and inquire if any adjustment in price is possible, "
                "while keeping a polite and engaging tone."
            )
        elif stage == "payment":
            base_prompt = (
                f"[Simulation] You are buyer {buyer} confirming that you have simulated a payment for {quantity} unit(s) of '{product}' "
                f"using your crypto wallet. Include a simulated transaction id {txid} and wallet address {wallet}, and ask what the next steps are."
            )
        elif stage == "dispute":
            base_prompt = (
                f"[Simulation] You are buyer {buyer} raising concerns about the quality or price for '{product}'. "
                "Express your disappointment and request either a discount or additional assurances, using a firm yet professional tone."
            )
    elif role.lower() == "seller":
        if stage == "specification":
            base_prompt = (
                f"[Simulation] You are seller {seller}. Confirm that '{product}' is available and meets high-quality standards. "
                f"Inform buyer {buyer} that you use a secure simulated escrow service (id {escrow_id}) and ask them to confirm their secure contact details. "
                "Keep your tone professional and detailed."
            )
        elif stage == "counter_offer":
            base_prompt = (
                f"[Simulation] You are seller {seller} responding to buyer {buyer} regarding '{product}'. "
                "Acknowledge their request for clarification and indicate that you can offer a slight discount or extra benefits. Use a persuasive tone."
            )
        elif stage == "finalization":
            base_prompt = (
                f"[Simulation] You are seller {seller}. Confirm that the simulated payment for {quantity} unit(s) of '{product}' has been verified. "
                "State that the order will be dispatched soon and tracking details will follow, using varied and natural language."
            )
        elif stage == "offer_extra":
            # Get extra items from the centralized product configuration
            product_config = get_product_by_name(product)
            extra_items = product_config["extra_items"] if product_config else []
            extra_item = random.choice(extra_items) if extra_items else "special offer"
            base_prompt = (
                f"[Simulation] You are seller {seller}. After confirming the sale of '{product}', kindly offer buyer {buyer} an additional product: "
                f"'{extra_item}' at a special discounted rate. Use a friendly and persuasive tone."
            )
        elif stage == "cancellation":
            base_prompt = (
                f"[Simulation] You are seller {seller} and need to cancel the negotiation with buyer {buyer} for '{product}'. "
                "Explain that the terms cannot be met and the transaction is cancelled, using a final and professional tone."
            )
    return get_llm_message(base_prompt)

# -------------------------------
# Conversation Generation Functions
# -------------------------------
def generate_successful_conversation(conv_id, base_time, buyer, seller, product):
    """
    Generate a successful conversation with a variable number of negotiation steps.
    The structure always starts with initiation and specification, and may include extra negotiation rounds.
    """
    turns = []
    price = random_price(product)
    payment_type = choose_payment_type()
    quantity = choose_quantity()
    escrow_id = generate_escrow_id()

    # Turn 1: Buyer initiation
    message1 = generate_role_message("Buyer", "initiation", buyer, seller, product, price, payment_type=payment_type, quantity=quantity)
    turn1 = {
        "turn_order": 1,
        "timestamp": base_time.isoformat(),
        "role": "Buyer",
        "handle": buyer,
        "message": message1,
        "negotiation_stage": "initiation",
        "coded_language": True,
        "security_flags": {"encrypted": True, "pgp_key_exchanged": True},
        "payment_details": None
    }
    turns.append(turn1)

    # Turn 2: Seller specification
    message2 = generate_role_message("Seller", "specification", buyer, seller, product, price, escrow_id=escrow_id)
    turn2 = {
        "turn_order": 2,
        "timestamp": (base_time + datetime.timedelta(minutes=3)).isoformat(),
        "role": "Seller",
        "handle": seller,
        "message": message2,
        "negotiation_stage": "specification",
        "coded_language": True,
        "security_flags": {"encrypted": True, "pgp_key_exchanged": True},
        "payment_details": {"escrow_id": escrow_id, "crypto_wallet_requested": True}
    }
    turns.append(turn2)

    current_turn = 3
    
    # With 50% chance, add a buyer negotiation turn asking for further clarifications or discount.
    if random.random() < 0.5:
        message3 = generate_role_message("Buyer", "negotiation", buyer, seller, product, price, payment_type=payment_type)
        turn3 = {
            "turn_order": current_turn,
            "timestamp": (base_time + datetime.timedelta(minutes=5)).isoformat(),
            "role": "Buyer",
            "handle": buyer,
            "message": message3,
            "negotiation_stage": "negotiation",
            "coded_language": True,
            "security_flags": {"encrypted": True, "pgp_key_exchanged": True},
            "payment_details": None
        }
        turns.append(turn3)
        current_turn += 1

        # With 60% chance, have the seller counter with a counter‑offer turn.
        if random.random() < 0.6:
            message_counter = generate_role_message("Seller", "counter_offer", buyer, seller, product, price, escrow_id=escrow_id)
            turn_counter = {
                "turn_order": current_turn,
                "timestamp": (base_time + datetime.timedelta(minutes=7)).isoformat(),
                "role": "Seller",
                "handle": seller,
                "message": message_counter,
                "negotiation_stage": "counter_offer",
                "coded_language": True,
                "security_flags": {"encrypted": True, "pgp_key_exchanged": True},
                "payment_details": None
            }
            turns.append(turn_counter)
            current_turn += 1

    # Turn for buyer payment confirmation
    wallet = generate_random_wallet()
    txid = generate_random_txid()
    message_payment = generate_role_message("Buyer", "payment", buyer, seller, product, price, wallet=wallet, txid=txid, payment_type=payment_type, quantity=quantity)
    turn_payment = {
        "turn_order": current_turn,
        "timestamp": (base_time + datetime.timedelta(minutes=10)).isoformat(),
        "role": "Buyer",
        "handle": buyer,
        "message": message_payment,
        "negotiation_stage": "payment",
        "coded_language": False,
        "security_flags": {"encrypted": True, "pgp_key_exchanged": True},
        "payment_details": {"crypto_wallet": wallet, "transaction_id": txid, "amount": f"{price:.2f} {payment_type} per unit"}
    }
    turns.append(turn_payment)
    current_turn += 1

    # Seller finalization turn
    message_final = generate_role_message("Seller", "finalization", buyer, seller, product, price)
    turn_final = {
        "turn_order": current_turn,
        "timestamp": (base_time + datetime.timedelta(minutes=13)).isoformat(),
        "role": "Seller",
        "handle": seller,
        "message": message_final,
        "negotiation_stage": "finalization",
        "coded_language": False,
        "security_flags": {"encrypted": True, "pgp_key_exchanged": True},
        "payment_details": {"transaction_status": "confirmed", "delivery_info": "Tracking details to follow."}
    }
    turns.append(turn_final)
    current_turn += 1

    # Optionally, with 30% chance, add a seller extra‑offer turn.
    if random.random() < 0.3:
        message_extra = generate_role_message("Seller", "offer_extra", buyer, seller, product, price)
        turn_extra = {
            "turn_order": current_turn,
            "timestamp": (base_time + datetime.timedelta(minutes=16)).isoformat(),
            "role": "Seller",
            "handle": seller,
            "message": message_extra,
            "negotiation_stage": "offer_extra",
            "coded_language": True,
            "security_flags": {"encrypted": True, "pgp_key_exchanged": True},
            "payment_details": None
        }
        turns.append(turn_extra)
    
    conversation = {
        "conversation_id": conv_id,
        "turns": turns,
        "outcome": "successful"
    }
    return conversation

def generate_unsuccessful_conversation(conv_id, base_time, buyer, seller, product):
    """
    Generate an unsuccessful conversation with a variable number of dispute steps.
    The flow includes buyer initiation, seller specification, buyer dispute (or negotiation), and seller cancellation.
    """
    turns = []
    price = random_price(product)
    payment_type = choose_payment_type()
    
    # Turn 1: Buyer initiation
    message1 = generate_role_message("Buyer", "initiation", buyer, seller, product, price, payment_type=payment_type)
    turn1 = {
        "turn_order": 1,
        "timestamp": base_time.isoformat(),
        "role": "Buyer",
        "handle": buyer,
        "message": message1,
        "negotiation_stage": "initiation",
        "coded_language": True,
        "security_flags": {"encrypted": True, "pgp_key_exchanged": True},
        "payment_details": None
    }
    turns.append(turn1)
    
    # Turn 2: Seller specification
    escrow_id = generate_escrow_id()
    message2 = generate_role_message("Seller", "specification", buyer, seller, product, price, escrow_id=escrow_id)
    turn2 = {
        "turn_order": 2,
        "timestamp": (base_time + datetime.timedelta(minutes=3)).isoformat(),
        "role": "Seller",
        "handle": seller,
        "message": message2,
        "negotiation_stage": "specification",
        "coded_language": True,
        "security_flags": {"encrypted": True, "pgp_key_exchanged": True},
        "payment_details": {"escrow_id": escrow_id, "crypto_wallet_requested": True}
    }
    turns.append(turn2)
    
    current_turn = 3
    # Add a buyer dispute turn.
    message_dispute = generate_role_message("Buyer", "dispute", buyer, seller, product, price, payment_type=payment_type)
    turn_dispute = {
        "turn_order": current_turn,
        "timestamp": (base_time + datetime.timedelta(minutes=6)).isoformat(),
        "role": "Buyer",
        "handle": buyer,
        "message": message_dispute,
        "negotiation_stage": "dispute",
        "coded_language": True,
        "security_flags": {"encrypted": True, "pgp_key_exchanged": True},
        "payment_details": None
    }
    turns.append(turn_dispute)
    current_turn += 1

    # Optionally, add another buyer dispute follow-up turn with 40% chance.
    if random.random() < 0.4:
        message_dispute2 = generate_role_message("Buyer", "dispute", buyer, seller, product, price, payment_type=payment_type)
        turn_dispute2 = {
            "turn_order": current_turn,
            "timestamp": (base_time + datetime.timedelta(minutes=8)).isoformat(),
            "role": "Buyer",
            "handle": buyer,
            "message": message_dispute2,
            "negotiation_stage": "dispute",
            "coded_language": True,
            "security_flags": {"encrypted": True, "pgp_key_exchanged": True},
            "payment_details": None
        }
        turns.append(turn_dispute2)
        current_turn += 1

    # Final Turn: Seller cancellation turn
    message_cancel = generate_role_message("Seller", "cancellation", buyer, seller, product, price)
    turn_cancel = {
        "turn_order": current_turn,
        "timestamp": (base_time + datetime.timedelta(minutes=11)).isoformat(),
        "role": "Seller",
        "handle": seller,
        "message": message_cancel,
        "negotiation_stage": "cancellation",
        "coded_language": False,
        "security_flags": {"encrypted": True, "pgp_key_exchanged": True},
        "payment_details": {"transaction_status": "cancelled"}
    }
    turns.append(turn_cancel)
    
    conversation = {
        "conversation_id": conv_id,
        "turns": turns,
        "outcome": "unsuccessful"
    }
    return conversation

def generate_random_conversation(conv_id):
    """Generate n simulated conversations with various steps, participants, products, and outcomes."""
    conversations = []
    buyers = ["ShadowWolf", "NightOwl", "PhantomAgent", "DarkRaven", "GhostRunner"]
    sellers = ["CrimsonFox", "SilverHawk", "Obsidian", "NightShade", "BlackIbis"]
    # Use product names from the centralized PRODUCTS array
    products = [product["name"] for product in PRODUCTS]
    
    base_datetime = datetime.datetime(2025, 6, 20, 7, 0, 0)
    
    buyer = random.choice(buyers)
    seller = random.choice(sellers)
    product = random.choice(products)
    outcome = random.choices(["successful", "unsuccessful"], weights=[70, 30])[0]
    offset_minutes = random.randint(0, 500)
    conv_time = base_datetime + datetime.timedelta(minutes=offset_minutes)
    conversation = 'failed'
    if outcome == "successful":
        conversation = generate_successful_conversation(conv_id, conv_time, buyer, seller, product)
    #else:
    #    conversation = generate_unsuccessful_conversation(conv_id, conv_time, buyer, seller, product)
 
    
    return conversation

import os
import json

def main():
    num_conversations = 50  # Number of conversations to generate
    max_retries = 2  # Maximum retries for each conversation
    output_dir = "convos"  # Directory where files will be stored
    os.makedirs(output_dir, exist_ok=True)

    for i in range(num_conversations):
        conv_id = f"conv_demo_{i+1:03d}"
        retries = 0
        success = False
        filename = os.path.join(output_dir, f"{conv_id}.json")

        if os.path.exists(filename):
            print(f"File {filename} already exists. Skipping...")
            continue

        while retries < max_retries and not success:
            conversation = generate_random_conversation(conv_id)  # Generate one conversation at a time
            
            if conversation != 'failed':  # Assume the function now returns None or False on failure
                success = True
            else:
                retries += 1
                print(f"Retry {retries}/{max_retries} for conversation {conv_id}...")

        if not success:
            print(f"Skipping conversation {conv_id} after {max_retries} retries.")
            continue

        # Write conversation to file immediately after successful generation
        
        try:
            with open(filename, "w") as f:
                json.dump(conversation, f, indent=2)
            print(f"Generated conversation {conv_id} and saved to {filename}")
        except Exception as file_error:
            print(f"Error writing conversation {conv_id} to file: {file_error}")

    print(f"Finished processing. Generated conversation files are located in '{output_dir}'.")


if __name__ == "__main__":
    main()

