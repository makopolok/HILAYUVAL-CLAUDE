import requests
from bs4 import BeautifulSoup
import json
import time
import re
import os
from urllib.parse import urljoin

def extract_imdb_links(md_filepath):
    """Extract project names and IMDb links from markdown file."""
    projects = []
    
    if not os.path.isfile(md_filepath):
        print(f"File not found: {md_filepath}")
        return projects
    
    with open(md_filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            # Match markdown links in format [Title]( URL )
            match = re.match(r"- \[(.*?)\]\(\s*(https://www\.imdb\.com/title/tt\d+/)\s*\)", line)
            if not match:
                # Try for indented links
                match = re.match(r"\s+- \[(.*?)\]\(\s*(https://www\.imdb\.com/title/tt\d+/)\s*\)", line)
            
            if match:
                title = match.group(1).strip()
                url = match.group(2).strip()
                projects.append((title, url))
    
    return projects

def scrape_imdb_details(title, url, session):
    """Scrape details from IMDb page."""
    print(f"Scraping: {title} - {url}")
    
    # Add browser-like headers
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.imdb.com/'
    }
    
    # Use the session object instead of requests directly
    response = session.get(url, headers=headers)
    time.sleep(5)  # Respect rate limits
    
    if response.status_code != 200:
        print(f"Failed to fetch {url}: HTTP {response.status_code}")
        return None
    
    soup = BeautifulSoup(response.text, "html.parser")
    
    # Create project ID from title and year
    year = extract_year(soup)
    project_id = f"{title.lower().replace(' ', '-')}-{year}" if year else f"{title.lower().replace(' ', '-')}"
    
    # Extract data from IMDb page
    project_data = {
        "id": project_id,
        "title": title,
        "titleHebrew": "",  # Not available on IMDb, would need another source
        "year": year,
        "rating": extract_type(soup),        cd E:\PROG\hilayuval-claude
        git add pyton_imdb/imdb_scraper.py
        git commit -m "Backup original IMDb scraper before enhancements"
        git push origin main
        "type": extract_type(soup),
        "episodes": extract_episodes(soup),
        "posterUrls": extract_poster_urls(soup),
        "description": extract_description(soup),
        "cast": extract_cast(soup),
        "yearSpan": extract_year_span(soup),
        "role": "Casting Director",  # Assuming Hila Yuval was the casting director
        "director": extract_director(soup),
        "productionCompany": extract_production_company(soup),
        "broadcaster": extract_broadcaster(soup),
        "seasons": extract_seasons(soup),
        "prizes": extract_prizes(soup),
        "imdbUrl": url,
        "trailerUrl": extract_trailer_url(soup)
    }
    
    return project_data

def extract_year(soup):
    """Extract release year."""
    try:
        year_elem = soup.select_one("span.sc-94726ce4-3")
        if year_elem:
            year_text = year_elem.get_text().strip()
            year_match = re.search(r"(\d{4})", year_text)
            if year_match:
                return int(year_match.group(1))
    except Exception as e:
        print(f"Error extracting year: {e}")
    
    return None

def extract_rating(soup):
    """Extract IMDb rating."""
    try:
        rating_elem = soup.select_one("span.sc-bde20123-1")
        if rating_elem:
            rating = float(rating_elem.get_text().strip())
            return rating
    except Exception as e:
        print(f"Error extracting rating: {e}")
    
    return None

def extract_type(soup):
    """Extract content type (Film/TV Series)."""
    try:
        type_elem = soup.select_one("a.ipc-chip--on-baseAlt")
        if type_elem and "TV Series" in type_elem.get_text():
            return "TV Series"
        return "Film"  # Default to Film
    except Exception as e:
        print(f"Error extracting type: {e}")
    
    return "Film"  # Default

def extract_episodes(soup):
    """Extract number of episodes for TV series."""
    try:
        if extract_type(soup) == "TV Series":
            episodes_elem = soup.select_one("span.ipc-title__subtext")
            if episodes_elem:
                episodes_text = episodes_elem.get_text()
                episodes_match = re.search(r"(\d+) episodes", episodes_text)
                if episodes_match:
                    return int(episodes_match.group(1))
    except Exception as e:
        print(f"Error extracting episodes: {e}")
    
    return None

def extract_poster_urls(soup):
    """Extract poster URLs."""
    poster_urls = []
    try:
        poster_elem = soup.select_one("img.ipc-image")
        if poster_elem and poster_elem.get("src"):
            poster_urls.append({"url": poster_elem["src"], "title": "Main Poster"})
    except Exception as e:
        print(f"Error extracting poster URLs: {e}")
    
    return poster_urls

def extract_description(soup):
    """Extract description/plot."""
    try:
        desc_elem = soup.select_one("span.sc-466bb6c-0")
        if desc_elem:
            return desc_elem.get_text().strip()
    except Exception as e:
        print(f"Error extracting description: {e}")
    
    return ""

def extract_cast(soup):
    """Extract cast members."""
    cast = []
    try:
        cast_elems = soup.select("a.sc-bfec09a1-1")
        for elem in cast_elems[:5]:  # Limit to first 5 cast members
            cast.append(elem.get_text().strip())
    except Exception as e:
        print(f"Error extracting cast: {e}")
    
    return cast

def extract_year_span(soup):
    """Extract year span for TV series."""
    try:
        year_elem = soup.select_one("span.sc-94726ce4-3")
        if year_elem:
            year_text = year_elem.get_text().strip()
            year_span_match = re.search(r"(\d{4}).*?(\d{4})", year_text)
            if year_span_match:
                return f"{year_span_match.group(1)}-{year_span_match.group(2)}"
            else:
                # Single year
                year_match = re.search(r"(\d{4})", year_text)
                if year_match:
                    return year_match.group(1)
    except Exception as e:
        print(f"Error extracting year span: {e}")
    
    return ""

def extract_director(soup):
    """Extract director name."""
    try:
        # Look for metadata items that contain the text "Director"
        director_section = None
        metadata_items = soup.select("li.ipc-metadata-list__item")
        for item in metadata_items:
            if "Director" in item.get_text():
                director_section = item
                break
        
        if director_section:
            director_link = director_section.select_one("a")
            if director_link:
                return director_link.get_text().strip()
    except Exception as e:
        print(f"Error extracting director: {e}")
    
    return ""

def extract_production_company(soup):
    """Extract production company."""
    try:
        # Look for metadata items that contain the text "Production company"
        company_section = None
        metadata_items = soup.select("li.ipc-metadata-list__item")
        for item in metadata_items:
            if "Production company" in item.get_text():
                company_section = item
                break
        
        if company_section:
            company_link = company_section.select_one("a")
            if company_link:
                return company_link.get_text().strip()
    except Exception as e:
        print(f"Error extracting production company: {e}")
    
    return ""

def extract_broadcaster(soup):
    """Extract broadcaster/network information."""
    try:
        # Look for metadata items that contain the text "Network" or "Broadcaster"
        network_section = None
        metadata_items = soup.select("li.ipc-metadata-list__item")
        for item in metadata_items:
            text = item.get_text().lower()
            if "network" in text or "broadcaster" in text:
                network_section = item
                break
        
        if network_section:
            network_link = network_section.select_one("a")
            if network_link:
                return network_link.get_text().strip()
    except Exception as e:
        print(f"Error extracting broadcaster: {e}")
    
    return ""

def extract_seasons(soup):
    """Extract number of seasons for TV series."""
    try:
        if extract_type(soup) == "TV Series":
            seasons_elem = soup.select_one("span.ipc-title__subtext")
            if seasons_elem:
                seasons_text = seasons_elem.get_text()
                seasons_match = re.search(r"(\d+) seasons?", seasons_text)
                if seasons_match:
                    return int(seasons_match.group(1))
    except Exception as e:
        print(f"Error extracting seasons: {e}")
    
    return None

def extract_prizes(soup):
    """Extract prizes/awards information."""
    prizes = {"actors": [], "castingDirector": []}
    try:
        awards_sections = soup.select("li.ipc-metadata-list__item")
        for section in awards_sections:
            if "Awards" in section.get_text() or "award" in section.get_text().lower():
                award_text = section.get_text().strip()
                prizes["actors"].append(award_text)
                break
    except Exception as e:
        print(f"Error extracting prizes: {e}")
    
    return prizes

def extract_trailer_url(soup):
    """Extract trailer URL."""
    try:
        # Find links that might contain trailer information
        trailer_links = soup.select("a.ipc-btn")
        for link in trailer_links:
            if "Trailer" in link.get_text():
                return urljoin("https://www.imdb.com", link.get("href", ""))
    except Exception as e:
        print(f"Error extracting trailer URL: {e}")
    
    return "https://youtube.com/..."  # Default placeholder
def main():
    md_filepath = "E:/PROG/hilayuval-claude/data/imdb-hila-yuval-projects.md"
    output_filepath = os.path.expanduser("~/Desktop/portfolio_imdb.json")
    
    print(f"Reading MD file from: {md_filepath}")
    print(f"Will save JSON to: {output_filepath}")
    
    # Create a session for persistent cookies
    session = requests.Session()
    
    # Extract project links
    projects = extract_imdb_links(md_filepath)
    print(f"Found {len(projects)} projects in the Markdown file")
    
    if not projects:
        print("No projects to scrape. Exiting.")
        return
    
    # Scrape details for each project
    all_projects = []
    for i, (title, url) in enumerate(projects):
        print(f"Processing project {i+1}/{len(projects)}: {title}")
        # Pass the session to your scrape function
        project_data = scrape_imdb_details(title, url, session)
        if project_data:
            all_projects.append(project_data)
            print(f"Successfully scraped data for: {title}")
        else:
            print(f"Failed to get data for: {title}")
        time.sleep(10)  # Increased delay between requests
    
    # Check if we have any data to save
    print(f"Total projects scraped successfully: {len(all_projects)}")
    if not all_projects:
        print("No data was scraped. Nothing to save.")
        return
        
    # Save results as JSON - PROPERLY INDENTED INSIDE THE FUNCTION
    try:
        portfolio = {"projects": all_projects}
        print("Attempting to save JSON file...")
        
        # Add this line here to ensure the directory exists
        os.makedirs(os.path.dirname(output_filepath), exist_ok=True)
        
        with open(output_filepath, "w", encoding="utf-8") as f:
            json.dump(portfolio, f, indent=2, ensure_ascii=False)
        print(f"✅ Data saved in '{output_filepath}'!")
    except Exception as e:
        print(f"Error saving JSON file: {e}")


if __name__ == "__main__":
    main()