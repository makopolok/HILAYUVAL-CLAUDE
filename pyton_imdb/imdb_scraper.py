import requests
from bs4 import BeautifulSoup
import re
import json
import time
import os

def extract_imdb_links(md_filepath):
    """Extract IMDb links from a markdown file."""
    links = []
    with open(md_filepath, 'r', encoding='utf-8') as f:
        content = f.read()
        pattern = r'\[([^\]]+)\]\((https://www\.imdb\.com/title/tt[0-9]+)\)'
        matches = re.findall(pattern, content)
        for title, url in matches:
            links.append((title.strip(), url.strip()))
    return links

def get_text_or_default(soup, selector, default="Unknown"):
    elem = soup.select_one(selector)
    return elem.get_text(strip=True) if elem else default

def get_list_from_links(soup, selector):
    return [a.get_text(strip=True) for a in soup.select(selector)] or ["Unknown"]

def scrape_imdb_details(title, url, session):
    print(f"Scraping: {title} from {url}")
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
    }
    try:
        response = session.get(url, headers=headers, timeout=15)
        if response.status_code != 200:
            print(f"Failed to access {url}: {response.status_code}")
            return None
        soup = BeautifulSoup(response.text, 'html.parser')

        # Title and year
        year = get_text_or_default(soup, 'span.sc-8c396aa2-2, .TitleBlockMetaData__ListItemText-sc-12ein40-2')
        rating = get_text_or_default(soup, 'span.sc-7ab21ed2-1, .AggregateRatingButton__RatingScore-sc-1ll29m0-1')
        genres = get_list_from_links(soup, 'a[href*="/search/title/?genres="], span.ipc-chip__text')
        runtime = get_text_or_default(soup, 'li[data-testid="title-techspec_runtime"] span, .TitleBlockMetaData__ListItemText-sc-12ein40-2')
        plot = get_text_or_default(soup, '[data-testid="plot-xl"], .GenresAndPlot__TextContainerBreakpointXS_TO_M-cum89p-0')
        language = get_list_from_links(soup, 'li[data-testid="title-details-languages"] a')
        country = get_list_from_links(soup, 'li[data-testid="title-details-origin"] a')
        production = get_list_from_links(soup, 'li[data-testid="title-details-companies"] a')
        poster_elem = soup.select_one('img.ipc-image[alt*="Poster"], .poster img')
        poster_url = poster_elem['src'] if poster_elem and 'src' in poster_elem.attrs else "No poster available"
        cast = get_list_from_links(soup, '[data-testid="title-cast-item__actor"] a, .cast_list td.primary_photo + td a')[:5]
        creators = get_list_from_links(soup, 'li[data-testid="title-pc-principal-credit"]:has(span:contains("Creator")) a')
        directors = get_list_from_links(soup, 'li[data-testid="title-pc-principal-credit"]:has(span:contains("Director")) a')
        writers = get_list_from_links(soup, 'li[data-testid="title-pc-principal-credit"]:has(span:contains("Writer")) a')
        box_office = get_text_or_default(soup, 'li[data-testid="title-boxoffice-cumulativeworldwidegross"] span')
        budget = get_text_or_default(soup, 'li[data-testid="title-boxoffice-budget"] span')
        release_date = get_text_or_default(soup, 'li[data-testid="title-details-releasedate"] a')
        episodes = get_text_or_default(soup, 'li[data-testid="episodes-header"] span, .bp_heading:contains("Episode Guide")')
        content_type = "TV Series" if "episodes" in episodes.lower() or creators != ["Unknown"] else "Film"

        return {
            "Title": title,
            "IMDb URL": url,
            "Year": year,
            "Rating": rating,
            "Genres": genres,
            "Runtime": runtime,
            "Plot": plot,
            "Language": language,
            "Country": country,
            "Production Company": production,
            "Poster URL": poster_url,
            "Cast": cast,
            "Creators": creators if content_type == "TV Series" else [],
            "Directors": directors if content_type == "Film" else [],
            "Writers": writers,
            "Box Office": box_office,
            "Budget": budget,
            "Release Date": release_date,
            "Episodes": episodes if content_type == "TV Series" else "",
            "Type": content_type
        }
    except Exception as e:
        print(f"Error scraping {title}: {e}")
        return None

def main():
    md_filepath = "E:/PROG/hilayuval-claude/data/imdb-hila-yuval-projects.md"
    output_filepath = "E:/PROG/hilayuval-claude/data/portfolio_imdb.json"
    session = requests.Session()
    projects = extract_imdb_links(md_filepath)
    print(f"Found {len(projects)} projects in the Markdown file")
    all_projects = []
    for i, (title, url) in enumerate(projects):
        print(f"Processing project {i+1}/{len(projects)}: {title}")
        project_data = scrape_imdb_details(title, url, session)
        if project_data:
            all_projects.append(project_data)
            print(f"Successfully scraped data for: {title}")
        else:
            print(f"Failed to get data for: {title}")
        time.sleep(5)
    os.makedirs(os.path.dirname(output_filepath), exist_ok=True)
    with open(output_filepath, "w", encoding="utf-8") as f:
        json.dump({"projects": all_projects}, f, indent=2, ensure_ascii=False)
    print(f"✅ Data saved in '{output_filepath}'!")

if __name__ == "__main__":
    main()