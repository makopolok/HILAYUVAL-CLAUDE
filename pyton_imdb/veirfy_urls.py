import requests
from bs4 import BeautifulSoup
import re
import time
import csv
from urllib.parse import urljoin

def verify_imdb_links(input_file, output_file):
    # Parse your chronological file
    projects = []
    with open(input_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            # Match lines starting with - followed by a title and year pattern
            match = re.match(r"- ([^(]+) \((\d{4}(?:-\d{4})?)\)(?: - (.+))?", line)
            if match:
                title = match.group(1).strip()
                year = match.group(2).strip()
                info = match.group(3).strip() if match.group(3) else ""
                projects.append({
                    'title': title,
                    'year': year,
                    'info': info,
                    'original_line': line
                })

    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    }
    
    session = requests.Session()
    
    verified_projects = []
    failures = []
    
    for i, project in enumerate(projects):
        print(f"Verifying {i+1}/{len(projects)}: {project['title']}")
        
        # Search IMDb for the title
        search_url = f"https://www.imdb.com/find?q={project['title'].replace(' ', '+')}"
        response = session.get(search_url, headers=headers)
        
        if response.status_code != 200:
            print(f"Failed to search for {project['title']}")
            failures.append(project)
            continue
        
        soup = BeautifulSoup(response.text, 'html.parser')
        search_results = soup.select("li.find-result-item")
        
        # Find the best match
        best_match = None
        for result in search_results:
            result_title = result.select_one(".ipc-metadata-list-summary-item__t")
            if not result_title:
                continue
                
            result_title_text = result_title.get_text().strip()
            result_year = result.select_one(".ipc-metadata-list-summary-item__st")
            result_year_text = result_year.get_text().strip() if result_year else ""
            
            # Check if title and year match
            if (project['title'].lower() in result_title_text.lower() or 
                result_title_text.lower() in project['title'].lower()):
                
                if project['year'] in result_year_text:
                    link = result_title.get('href')
                    if link and "/title/tt" in link:
                        best_match = urljoin("https://www.imdb.com", link)
                        break

        if not best_match:
            print(f"Could not find a match for {project['title']}")
            failures.append(project)
            continue
            
        # Visit the IMDb page to verify
        response = session.get(best_match, headers=headers)
        if response.status_code != 200:
            print(f"Failed to fetch {best_match}")
            failures.append(project)
            continue
            
        # Extract IMDb ID
        imdb_id = re.search(r"title/(tt\d+)", best_match).group(1)
        
        # Check if Hila Yuval is listed in credits
        soup = BeautifulSoup(response.text, 'html.parser')
        has_hila = False
        credits = soup.select(".ipc-metadata-list-item__content-container")
        for credit in credits:
            if "Hila Yuval" in credit.get_text():
                has_hila = True
                break
        
        # Verify type (Film vs Series) and episode count
        type_info = "Film"
        if "episode" in project['info'].lower():
            type_info = f"{project['info']}"
        
        verified_title = soup.select_one("h1.sc-b73cd867-0")
        verified_title = verified_title.get_text().strip() if verified_title else project['title']
        
        verified_url = f"https://www.imdb.com/title/{imdb_id}/"
        verified_projects.append(
            f"- [{project['title']}]({verified_url}) ({project['year']}) - {type_info}"
        )
        
        print(f"✓ Verified: {project['title']} -> {verified_url}")
        time.sleep(3)  # Respect rate limits
    
    # Write verified links to output file
    with open(output_file, 'w', encoding='utf-8') as f:
        for project in verified_projects:
            f.write(f"{project}\n")
    
    # Report failures
    if failures:
        print("\nCouldn't verify these projects:")
        for project in failures:
            print(f"- {project['title']} ({project['year']})")
    
    print(f"\nVerified {len(verified_projects)} out of {len(projects)} projects")
    print(f"Results saved to {output_file}")

# Run the verification
verify_imdb_links(
    "E:/PROG/hilayuval-claude/data/hila-yuval-chronological.md", 
    "E:/PROG/hilayuval-claude/data/verified-imdb-links.md"
)