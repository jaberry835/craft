
from datetime import datetime
import os  
import base64
import random
from openai import AzureOpenAI  

endpoint = os.getenv("ENDPOINT_URL", "https://jb-ai-test.openai.azure.com/")  
deployment = os.getenv("DEPLOYMENT_NAME", "gpt-4o")  
subscription_key = os.getenv("AZURE_OPENAI_API_KEY", "overwrite")  

# Initialize Azure OpenAI Service client with key-based authentication    
client = AzureOpenAI(  
    azure_endpoint=endpoint,  
    api_key=subscription_key,  
    api_version="2024-05-01-preview",
)

def split_company_info(input_string):
    # Split the string by commas and strip whitespace
    parts = [part.strip() for part in input_string.split(",")]

    # Check if the input contains the expected format
    if len(parts) >= 4:
        company_name = parts[0]
        location = f"{parts[1]}, {parts[2]}"
        language = parts[3]

        return company_name, location, language
    else:
        print("Input string is not in the expected format!")
        return None, None, None


# Split the string



def generate_fake_company_supporting_contact_docs(company, synopsis):
    """Generate supporting documents for a given company using Azure OpenAI."""
    company_name, location, language = split_company_info(company)
    chat_prompt = [
        {
            "role": "system",
            "content": """synposis for company {{ company_names }}, in location {location}
             {{ synopsis}}"""
        },
        {
            "role": "user",
            "content": """generate a contract document about the fictious company {company} in location {location}. Produce result in language {language}. 
            The contract should be a finanical, research or other type of relationship typical between companies, make it very technnical and 
            make the language very official and formal"""
        }
    ]
    
    response = client.chat.completions.create(
        model=deployment,
        messages=chat_prompt,
        max_tokens=4096,
        temperature=0.85,
        top_p=0.95,
        frequency_penalty=0,
        presence_penalty=0,
        stop=None,
        stream=False
    )
    
    # Extract the content from the response and return it
    contract = response.choices[0].message.content
    print(contract)
    
    return contract



def generate_fake_company_supporting_contact_docs(company, synopsis):
    """Generate supporting documents for a given company using Azure OpenAI."""
    company_name, location, language = split_company_info(company)
    chat_prompt = [
        {
            "role": "system",
            "content": """synposis for company {{ company_names }}, in location {location}
             {{ synopsis}}"""
        },
        {
            "role": "user",
            "content": """generate a contract document about the fictious company {company} in location {location}. Produce result in language {language}. 
            The contract should be a finanical, research or other type of relationship typical between companies, make it very technnical and 
            make the language very official and formal"""
        }
    ]
    
    response = client.chat.completions.create(
        model=deployment,
        messages=chat_prompt,
        max_tokens=4096,
        temperature=0.85,
        top_p=0.95,
        frequency_penalty=0,
        presence_penalty=0,
        stop=None,
        stream=False
    )
    
    # Extract the content from the response and return it
    contract = response.choices[0].message.content
    # (contract)
    
    return contract



def generate_fake_company_supporting_contact_financing_docs(company, synopsis):
    """Generate supporting documents for a given company using Azure OpenAI."""
    company_name, location, language = split_company_info(company)
    chat_prompt = [
        {
            "role": "system",
            "content": """synposis for company {{ company_names }}, in location {location}
             {{ synopsis}}"""
        },
        {
            "role": "user",
            "content": """generate a contract document about the fictious company {company} in location {location}. Produce result in language {language}. 
            The contract should be about funding recieved or given to another company, with fictious amounts, people involved, make it very technnical and 
            make the language very official and formal"""
        }
    ]
    
    response = client.chat.completions.create(
        model=deployment,
        messages=chat_prompt,
        max_tokens=4096,
        temperature=0.85,
        top_p=0.95,
        frequency_penalty=0,
        presence_penalty=0,
        stop=None,
        stream=False
    )
    
    # Extract the content from the response and return it
    contract = response.choices[0].message.content
 
    return contract




def generate_fake_company_supporting_contact_financial_statement_docs(company, synopsis, fiscal_year):
    """Generate supporting documents for a given company using Azure OpenAI."""
    company_name, location, language = split_company_info(company)
    chat_prompt = [
        {
            "role": "system",
            "content": """synposis for company {{ company_names }}, in location {location}
             {{ synopsis}}"""
        },
        {
            "role": "user",
            "content": """generate a financial statement document for fiscal year {{ fiscal_Year }}about the fictious company {company} in location {location}. Produce result in language {language}. 
            The financial statment should be like any company, make it very technnical and 
            make the language very official and formal"""
        }
    ]
    
    response = client.chat.completions.create(
        model=deployment,
        messages=chat_prompt,
        max_tokens=4096,
        temperature=0.85,
        top_p=0.95,
        frequency_penalty=0,
        presence_penalty=0,
        stop=None,
        stream=False
    )
    
    # Extract the content from the response and return it
    contract = response.choices[0].message.content
    # print(contract)
    
    return contract
    

def generate_sypnopsis(company):
    """Generate a synopsis for a given company using Azure OpenAI."""
    company_name, location, language = split_company_info(company)
    
    chat_prompt = [
        {
            "role": "system",
            "content": "You are an AI assistant that generates unique lists of fake company names."
        },
        {
            "role": "user",
            "content": f"""generate a synopsis about the fictious company {company} in location {location}. Produce result in language { language}. 
            The synposis should include information about size, industries, other companies it works with, people in leadership positions, revenus etc"""
        }
    ]


    response = client.chat.completions.create(
        model=deployment,
        messages=chat_prompt,
        max_tokens=4096,
        temperature=0.85,
        top_p=0.95,
        frequency_penalty=0,
        presence_penalty=0,
        stop=None,
        stream=False
    )
    
    # Extract the content from the response and return it
    synopsis = response.choices[0].message.content
    # print(synopsis)
    return synopsis
    
def generate_fake_company_names():
    """Generate a list of 10 fake company names using Azure OpenAI."""
    chat_prompt = [
        {
            "role": "system",
            "content": "You are an AI assistant that generates unique lists of fake company names."
        },
        {
            "role": "user",
            "content": """Generate a list of 50 unique fake company names, only return one company per line with no additional labels. 
                Do not put a number in front of the company.  
                Each company should be a unique name and be industries such as technology, finance, banking, energy, construction, real estate, supply chain, logistics,healthcare, 
                pharmaceuticals, insurance, and manufacturing.  
                The companies are located worldwide, and some have english names, 
                and others have names in russian, arabic, english, chinese, spanish.  
                For each fake company, put a location based off the language of the company comma seperated after the company name top include both the city, and country.  
                About 50% of the companies should be in english, and the other 50% should be in other languages. In addition, add some companies that may be located in carrebean countires
                known for laundering.   After the location, add a comma for the native language of the country it is located in"""
        }
    ]

    response = client.chat.completions.create(
        model=deployment,
        messages=chat_prompt,
        max_tokens=800,
        temperature=0.7,
        top_p=0.95,
        frequency_penalty=0,
        presence_penalty=0,
        stop=None,
        stream=False
    )
    
    # Extract the content from the response and split into lines
    company_names = response.choices[0].message.content.strip().splitlines()#.to_json().get('choices')[0].get('message').get('content').splitlines()
    # ['choices'][0]['message']['content'];
    print(company_names)
    return company_names

def save_to_file(fileType, company_name, content, i=0):
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    contract_filename = f"support_docs/{company_name.replace(' ', '_')}_{fileType}_{i + 1}_{timestamp}.txt"
    with open(contract_filename, "w", encoding="utf-8") as file:
        file.write(content)

def print_company_names(company_names):
    """Iterate through and print each company name."""
    for idx, company in enumerate(company_names, start=1):
        print(f"{idx}. {company.strip()}")
        print(f"synopsis for {company.strip()}")
        company_name, location, language = split_company_info(company)
        synopsis = generate_sypnopsis(company.strip())
        save_to_file('background',company_name,synopsis,0)
         
        num_executions = random.randint(0, 5)
        for i, _ in enumerate(range(num_executions)):
            generate_fake_company_supporting_contact_docs(company.strip(), synopsis)
            save_to_file('contract',company_name,synopsis, i)
        
     
        generate_fake_company_supporting_contact_financial_statement_docs(company.strip(), synopsis, 2025)
        save_to_file('fin_statement_2025',company_name,synopsis)
        
        generate_fake_company_supporting_contact_financial_statement_docs(company.strip(), synopsis, 2024)
        save_to_file('fin_statement_2024',company_name,synopsis)
        
        generate_fake_company_supporting_contact_financial_statement_docs(company.strip(), synopsis, 2023)
        save_to_file('fin_statement_2023',company_name,synopsis)
        
        num_executions = random.randint(0, 5)
        for i, _ in enumerate(range(num_executions)):
            generate_fake_company_supporting_contact_financing_docs(company.strip(), synopsis)
            save_to_file('fund_contract',company_name,synopsis, i)
        
        

# Main function
if __name__ == "__main__":
    try:
        # Generate the company names using ChatGPT
        company_list = generate_fake_company_names()
        
        # Print the company names to the console
        print_company_names(company_list)
    except Exception as e:
        print(f"An error occurred: {e}")