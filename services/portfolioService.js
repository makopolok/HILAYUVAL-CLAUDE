const path = require('path');
const portfolio = require(path.resolve(__dirname, '../data/portfolio_new.json'));

const projectLabels = {
    'Night Therapy': 'Psychological Drama',
    '8200': 'Intelligence Thriller',
    'Manayek': 'Police Corruption',
    'Metukim': 'Comedy Drama',
    'Dismissed': 'Army Comedy',
    'Red Skies': 'Second Intifada',
    'Six Zeros': 'Lottery Drama',
    'Alef': 'Political Scandal',
    'June Zero': 'Feature Film',
    'Chanshi': 'Culture Clash',
    'Broken Ties': 'Undercover Crime',
    'Malkot': 'Crime Family',
    'Kfulim': 'Conspiracy Thriller',
    'Sad City Girls': 'Friendship Drama',
    "Me'ila": 'True Crime',
    'Michael': 'Dark Comedy',
    'Shtisel': 'Haredi Family',
    'Valley of Tears': 'Yom Kippur War',
    'The Big Special Thing': 'Kan Drama',
    'The Attaché': 'Paris Embassy',
    'Happy Times': 'Dinner Party',
    'The Red Sea Diving Resort': 'Rescue Mission',
    'Our Boys': 'HBO / Keshet',
    'The Spy': 'Netflix',
    'Flawless': 'Teen Drama',
    'Beirut': 'American Feature',
    'The Conductor': 'Music Drama',
    'Autonomies': 'Dystopian Israel',
    'Commandments': 'Haredi Soldiers',
    'Driver': 'Bnei Brak',
    'Norman': 'International Feature',
    'Plan B': 'Comedy',
    'Imported': 'Sports Comedy',
    'Fauda': 'Political Thriller',
    'Dig': 'Jerusalem Mystery',
    'A Tale of Love and Darkness': 'Literary Feature',
    'The Gordin Cell': 'Spy Family',
    'Hill Start': 'Family Comedy',
    'Temporarily Dead': 'Medical Mystery',
    'A Place in Heaven': 'Historical Feature',
    'Euphoria': 'Youth Drama',
    'Lost Islands': '1980s Family',
    'Restless': 'Father-Son Drama',
    'Deus': 'AI Mystery',
    'Lost and Found': 'Ensemble Comedy',
    "Ulai Hapa'am": 'Tel Aviv Romance',
    'When Will We Kiss': 'Romantic Drama',
    'The Little Traitor': 'Mandate Era',
    'Beaufort': 'Berlin Winner',
    "Yeladot Ra'ot": 'Coming of Age',
    'Lemarit Ain': 'Psychological Thriller',
    'Live and Become': 'International Drama',
    'Rosh Gadol': 'Youth Series',
    'Meorav Yerushalmi': 'Jerusalem Drama',
    'Delusions': 'Psychological Drama',
    'The Last Scene': 'Cinema Drama',
    'Colombian Love': 'Romantic Comedy',
    'Summer Story': 'Feature Film',
    'Hallelujah': 'Feature Film',
    'BeKetzev HaKetzev': 'Feature Film',
    'Shaul': 'Feature Film',
    "The Azzany's": 'Family Drama',
    'Hafuch': 'Cult Series'
};

function getFallbackLabel(project) {
    if (project.broadcaster) return project.broadcaster;
    if (project.episodes === null || project.episodes === 'Film' || project.episodes === 'Feature Film') {
        return 'Feature Film';
    }
    if (project.storyline && /comedy/i.test(project.storyline)) return 'Comedy';
    if (project.storyline && /thriller|spy|crime|mystery/i.test(project.storyline)) return 'Thriller';
    return 'Drama';
}

function getSortYear(project) {
    const years = String(project.year || '').match(/\d{4}/g);
    if (!years) return 0;
    return Math.max(...years.map((year) => parseInt(year, 10)));
}

class PortfolioService {
    async getAllProjects() {
        return [...portfolio]
            .sort((a, b) => getSortYear(b) - getSortYear(a))
            .map((project) => ({
                ...project,
                portfolio_label: projectLabels[project.title] || getFallbackLabel(project)
            }));
    }
}

module.exports = new PortfolioService();
