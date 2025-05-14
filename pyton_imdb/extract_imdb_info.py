import json
import requests
from bs4 import BeautifulSoup
import time
import re

def extract_imdb_info(url):
    """
    Extract director and production company information from an IMDb URL.
    
    Args:
        url (str): The IMDb URL to scrape
        
    Returns:
        dict: A dictionary containing director and production_company information
    """
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    
    result = {
        'director': [],
        'production_company': []
    }
    
    try:
        # Add a delay to avoid being rate-limited
        time.sleep(1)
        
        # Make the request
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        # Parse the HTML content
        soup = BeautifulSoup(response.content, 'html.parser')
        
        # Find the director(s)
        # Different IMDb pages may have different structures, so we try multiple selectors
        director_section = soup.find('section', string=re.compile(r'Director|Directors', re.IGNORECASE))
        if director_section:
            director_links = director_section.find_all('a')
            for link in director_links:
                if link.text.strip() and not link.text.strip().startswith('See '):
                    result['director'].append(link.text.strip())
        
        # Try another selector for directors
        director_div = soup.find('div', {'data-testid': 'title-pc-principal-credit'})
        if director_div and not result['director']:
            director_links = director_div.find_all('a')
            for link in director_links:
                if link.text.strip() and not link.text.strip().startswith('See '):
                    result['director'].append(link.text.strip())
                    
        # Find the production company
        company_section = soup.find('section', string=re.compile(r'Production company|Production companies', re.IGNORECASE))
        if company_section:
            company_links = company_section.find_all('a')
            for link in company_links:
                if link.text.strip() and not link.text.strip().startswith('See '):
                    result['production_company'].append(link.text.strip())
        
        # Try another way to find production companies
        company_div = soup.find('li', {'data-testid': 'title-details-companies'})
        if company_div and not result['production_company']:
            company_links = company_div.find_all('a')
            for link in company_links:
                if link.text.strip() and not link.text.strip().startswith('See '):
                    result['production_company'].append(link.text.strip())
        
        # For TV series, try to find creators as alternative to directors
        if not result['director']:
            creator_section = soup.find('section', string=re.compile(r'Creator|Creators', re.IGNORECASE))
            if creator_section:
                creator_links = creator_section.find_all('a')
                for link in creator_links:
                    if link.text.strip() and not link.text.strip().startswith('See '):
                        result['director'].append(link.text.strip() + " (Creator)")
        
        # Convert lists to strings if needed
        if result['director']:
            result['director'] = ", ".join(result['director'])
        else:
            result['director'] = "Not found"
            
        if result['production_company']:
            result['production_company'] = ", ".join(result['production_company'])
        else:
            result['production_company'] = "Not found"
            
    except Exception as e:
        print(f"Error extracting info from {url}: {e}")
        result['director'] = "Error"
        result['production_company'] = "Error"
        
    return result

def update_portfolio_with_imdb_info(input_file, output_file):
    """
    Update the portfolio JSON with director and production company information.
    
    Args:
        input_file (str): Path to the input JSON file
        output_file (str): Path to the output JSON file
    """
    # Load the portfolio data
    with open(input_file, 'r', encoding='utf-8') as f:
        portfolio = json.load(f)
    
    # Process each project
    for i, project in enumerate(portfolio):
        print(f"Processing {i+1}/{len(portfolio)}: {project['title']}")
        
        # Skip if there's no IMDb URL
        if 'imdb_url' not in project or not project['imdb_url']:
            continue
        
        # Skip if director and production company are already specified
        if (project.get('director') and project['director'] != "Not specified" and
            project.get('production_company') and project['production_company'] != "Not specified"):
            print(f"  Already has info: {project['title']}")
            continue
        
        # Extract info from IMDb
        info = extract_imdb_info(project['imdb_url'])
        
        # Update the project data
        if project.get('director') == "Not specified" or not project.get('director'):
            project['director'] = info['director']
        
        if project.get('production_company') == "Not specified" or not project.get('production_company'):
            project['production_company'] = info['production_company']
    
    # Save the updated portfolio data
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(portfolio, f, ensure_ascii=False, indent=2)
    
    print(f"Updated portfolio saved to {output_file}")

if __name__ == "__main__":
    input_file = "../data/portfolio_new.json"
    output_file = "../data/portfolio_updated.json"
    update_portfolio_with_imdb_info(input_file, output_file)