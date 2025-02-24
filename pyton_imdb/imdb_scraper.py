import requests
from bs4 import BeautifulSoup
import json
import time
from tqdm import tqdm  # Progress bar
from urllib.parse import urljoin

# IMDb URL for Hila Yuval's credits
HILA_YUVAL_IMDB_URL = "https://www.imdb.com/name/nm1382130/"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
}

def get_project_links():
    """Scrapes the IMDb page to get all project links."""
    response = requests.get(HILA_YUVAL_IMDB_URL, headers=HEADERS)
    if response.status_code != 200:
        print(f"Failed to fetch IMDb page: {response.status_code}")
        return []

    soup = BeautifulSoup(response.text, "html.parser")
    projects = []

    for link in soup.find_all("a", href=True):
        href = link["href"].split("?")[0]
        if href.startswith("/title/tt"):
            full_url = urljoin("https://www.imdb.com", href)
            projects.append(full_url)

    return list(set(projects))  # Remove duplicates

def get_movie_details(imdb_url):
    """Fetches details for a single movie or TV show."""
    response = requests.get(imdb_url, headers=HEADERS)
    if response.status_code != 200:
        return {"error": f"Failed to fetch {imdb_url}"}

    soup = BeautifulSoup(response.text, "html.parser")

    title = soup.find("h1").text.strip() if soup.find("h1") else "Unknown"
    year = soup.find("span", class_="sc-8c396aa2-2").text.strip() if soup.find("span", class_="sc-8c396aa2-2") else "Unknown"
    rating = soup.find("span", class_="sc-bde20123-1").text.strip() if soup.find("span", class_="sc-bde20123-1") else "N/A"
    
    # Extract director(s)
    director_tag = soup.find("span", string="Director") or soup.find("span", string="Directors")
    director = [d.text.strip() for d in director_tag.find_next_siblings("a")] if director_tag else ["Unknown"]

    # Extract writers
    writer_tag = soup.find("span", string="Writer") or soup.find("span", string="Writers")
    writers = [w.text.strip() for w in writer_tag.find_next_siblings("a")] if writer_tag else ["Unknown"]

    # Extract stars
    star_section = soup.find("div", class_="ipc-metadata-list-item__content-container")
    stars = [s.text.strip() for s in star_section.find_all("a")[:5]] if star_section else ["Unknown"]  # Limit to 5 main actors

    # Extract genres
    genre_tags = soup.find_all("a", href=lambda x: x and "/search/title?genres=" in x)
    genres = [g.text.strip() for g in genre_tags] if genre_tags else ["Unknown"]

    # Extract runtime
    runtime_tag = soup.find("span", class_="sc-8c396aa2-2")
    runtime = runtime_tag.text.strip() if runtime_tag else "Unknown"

    # Extract country
    country_tag = soup.find("a", href=lambda x: x and "/search/title?country_of_origin=" in x)
    country = country_tag.text.strip() if country_tag else "Unknown"

    # Extract language
    language_tag = soup.find("a", href=lambda x: x and "/search/title?primary_language=" in x)
    language = language_tag.text.strip() if language_tag else "Unknown"

    # Extract production company
    production_tag = soup.find("a", href=lambda x: x and "/company/" in x)
    production_company = production_tag.text.strip() if production_tag else "Unknown"

    # Extract budget and box office (if available)
    budget = "Not Available"
    box_office = "Not Available"
    for item in soup.find_all("li", class_="ipc-metadata-list__item"):
        if "Budget" in item.text:
            budget = item.text.split(":")[-1].strip()
        if "Gross worldwide" in item.text:
            box_office = item.text.split(":")[-1].strip()

    # Extract release date
    release_date_tag = soup.find("a", href=lambda x: x and "/releaseinfo" in x)
    release_date = release_date_tag.text.strip() if release_date_tag else "Unknown"

    # Extract plot summary
    plot_tag = soup.find("span", class_="sc-16ede01-2")
    plot_summary = plot_tag.text.strip() if plot_tag else "No summary available"

  

def main():
    """Scrapes all projects and saves them in JSON format."""
    print("Fetching project links...")
    project_links = get_project_links()

    if not project_links:
        print("No projects found!")
        return

    all_movies = []

    print(f"Scraping {len(project_links)} projects...\n")
    for url in tqdm(project_links):
        movie_data = get_movie_details(url)
        all_movies.append(movie_data)
        time.sleep(5)  # Avoid IMDb rate limits

    # Save data to JSON file
    with open("hila_yuval_projects.json", "w", encoding="utf-8") as f:
        json.dump(all_movies, f, indent=4, ensure_ascii=False)

    print("\n✅ Data saved in 'hila_yuval_projects.json'!")

if __name__ == "__main__":
    main()
