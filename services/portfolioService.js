const path = require('path');
const portfolio = require(path.resolve(__dirname, '../data/portfolio_new.json'));

const projectLabels = {
    'All Mothers Lie': 'Motherhood Drama',
    'Unconditional': 'Crime Thriller',
    'Yaffa': 'Crime Thriller',
    'Matkalistim': 'Comedy Drama',
    'YeledHara': 'Comedy Series',
    'Dead Language': 'Drama Mystery',
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

const projectHebrewTitles = {
    'All Mothers Lie': 'כל האמהות משקרות',
    'Unconditional': 'הבת',
    'Yaffa': 'יאפא',
    'Matkalistim': 'מטכ"ליסטים',
    'YeledHara': 'ילד חרא',
    'Dead Language': 'שפה זרה',
};

const projectVisuals = {
    'Manayek': {
        featured_image_url: '/images/accordion-headers/manayek_header_blue.jpg',
        featured_image_alt: 'Manayek artwork',
        featured_image_object_position: 'center 35%',
    },
    'Dismissed': {
        featured_image_url: '/images/accordion-headers/dissmissed_header.jpg',
        featured_image_alt: 'Dismissed header art',
        featured_image_object_position: 'center 60%',
    },
    'Six Zeros': {
        featured_image_url: '/images/accordion-headers/sixzeros_header_yellow.jpg',
        featured_image_alt: 'Six Zeros artwork',
        featured_image_object_position: 'center 50%',
    },
    'Temporarily Dead': {
        featured_image_url: '/images/accordion-headers/metim_rega_header.jpg',
        featured_image_alt: 'Temporarily Dead header art',
        featured_image_object_position: 'center 55%',
    },
    'Valley of Tears': {
        featured_image_url: '/images/accordion-headers/valey of tears_header.webp',
        featured_image_alt: 'Valley of Tears header art',
        featured_image_object_position: 'center center',
    },
    'The Red Sea Diving Resort': {
        featured_image_url: '/images/posterim/metim_larega_publicity.jpg',
        featured_image_alt: 'The Red Sea Diving Resort visual',
        featured_image_object_position: 'center 45%',
    },
    'Our Boys': {
        featured_image_url: '/images/accordion-headers/OURBOYES_POSTER.png',
        featured_image_alt: 'Our Boys poster',
        featured_image_object_position: 'center center',
    },
    'Shtisel': {
        featured_image_url: '/images/accordion-headers/shtisel_poster.webp',
        featured_image_alt: 'Shtisel poster',
        featured_image_object_position: 'center center',
    },
    '8200': {
        featured_image_url: '/images/posterim/manayek_still.jpg',
        featured_image_alt: '8200 visual reference',
        featured_image_object_position: 'center center',
    },
    'Night Therapy': {
        featured_image_url: '/images/posterim/hamefakedet_publicity.jpg',
        featured_image_alt: 'Night Therapy visual reference',
        featured_image_object_position: 'center center',
    },
    'Yaffa': {
        featured_image_url: '/images/posterim/six_zeros_still.jpg',
        featured_image_alt: 'Yaffa visual reference',
        featured_image_object_position: 'center 43%',
    },
    'Matkalistim': {
        featured_image_url: '/images/posterim/metim_larega_publicity.jpg',
        featured_image_alt: 'Matkalistim visual reference',
        featured_image_object_position: 'center 44%',
    },
    'Dead Language': {
        featured_image_url: '/images/posterim/manayek.jpg',
        featured_image_alt: 'Dead Language visual reference',
        featured_image_object_position: 'center 24%',
    },
    'The Spy': {
        featured_image_url: '/images/posterim/six_zeros.jpg',
        featured_image_alt: 'The Spy visual reference',
        featured_image_object_position: 'center center',
    },
    'Fauda': {
        featured_image_url: '/images/accordion-headers/fauda_header_poster.jpg',
        featured_image_alt: 'Fauda poster',
        featured_image_object_position: 'center center',
    },
};

const INTERNATIONAL_PROJECT_TITLES = new Set([
    'The Red Sea Diving Resort',
    'The Spy',
    'Beirut',
    'Norman',
    'Live and Become',
    'A Tale of Love and Darkness',
    'The Attaché',
    'The Conductor',
    'The Big Special Thing',
]);

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

function slugifyTitle(title) {
    return String(title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function getPortfolioCategories(project, portfolioLabel) {
    const categories = [];
    const label = String(portfolioLabel || '').toLowerCase();
    const episodes = project.episodes;

    if (typeof episodes === 'number' && Number.isFinite(episodes)) {
        categories.push('TV Series');
    } else if (episodes === null || episodes === 'Film' || episodes === 'Feature Film') {
        categories.push('Feature Films');
    }

    if (label.includes('comedy')) {
        categories.push('Comedy');
    }

    if (label.includes('drama')) {
        categories.push('Drama');
    }

    if (
        INTERNATIONAL_PROJECT_TITLES.has(project.title)
        || label.includes('international')
        || label.includes('hbo')
        || label.includes('netflix')
        || label.includes('american')
        || label.includes('paris')
        || label.includes('berlin')
    ) {
        categories.push('International Productions');
    }

    return [...new Set(categories)];
}

class PortfolioService {
    async getAllProjects() {
        const projects = [...portfolio]
            .sort((a, b) => getSortYear(b) - getSortYear(a))
            .map((project) => {
                const portfolio_label = projectLabels[project.title] || getFallbackLabel(project);
                const portfolio_categories = getPortfolioCategories(project, portfolio_label);
                return {
                    ...project,
                    slug: slugifyTitle(project.title),
                    portfolio_label,
                    portfolio_categories,
                    portfolio_categories_csv: portfolio_categories.join(','),
                    hebrew_title: projectHebrewTitles[project.title] || project.hebrew_title,
                    ...(projectVisuals[project.title] || {}),
                };
            });
        const featuredOrder = ['Manayek', 'Dismissed'];
        const featuredProjects = featuredOrder
            .map((title) => projects.find((project) => project.title === title))
            .filter(Boolean);
        return { projects, featuredProjects };
    }
}

module.exports = new PortfolioService();
