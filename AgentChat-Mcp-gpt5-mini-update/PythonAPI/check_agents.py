import asyncio
import httpx
import json

async def check_agent_names():
    addresses = [
        'http://localhost:18081',
        'http://localhost:18082', 
        'http://localhost:18083',
        'http://localhost:18084'
    ]
    
    async with httpx.AsyncClient(timeout=5) as client:
        for addr in addresses:
            try:
                r = await client.get(f'{addr}/a2a/card')
                if r.status_code == 200:
                    card = r.json()
                    print(f'{addr}:')
                    print(f'  Name: {card.get("name", "Unknown")}')
                    print(f'  Description: {card.get("description", "No description")}')
                    print()
            except Exception as e:
                print(f'{addr} - Error: {e}')

asyncio.run(check_agent_names())
