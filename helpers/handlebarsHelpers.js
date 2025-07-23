const Handlebars = require('handlebars');

module.exports = {
    renderProjectDetail: function(label, value) {
        // These checks ensure that no empty or irrelevant categories are displayed.

        if (value === null || typeof value === 'undefined') {
            return ''; // Handles null or undefined
        }

        let displayValueStr = '';

        if (typeof value === 'string') {
            const originalTrimmedValue = value.trim();
            if (originalTrimmedValue === '') {
                return ''; // Handles strings that are empty after trimming
            }
            // Normalize for comparison: replace multiple spaces with one, then toLowerCase
            const normalizedForCompare = originalTrimmedValue.replace(/\s+/g, ' ').toLowerCase();
            if (normalizedForCompare === 'not specified') {
                return ''; // Handles "Not specified" (case-insensitive, normalized whitespace)
            }
            displayValueStr = Handlebars.Utils.escapeExpression(originalTrimmedValue);
        } else if (Array.isArray(value)) {
            if (value.length === 0) {
                return ''; // Handles empty arrays
            }
            const filteredArray = value
                .map(item => (typeof item === 'string' ? item.trim() : item)) // Trim string items
                .filter(item => {
                    if (typeof item === 'string') {
                        if (item === '') return false; // Filter out empty strings after trimming
                        // Normalize for comparison: replace multiple spaces with one, then toLowerCase
                        const normalizedForCompare = item.replace(/\s+/g, ' ').toLowerCase();
                        return normalizedForCompare !== 'not specified';
                    }
                    return true; // Keep non-string items
                });

            if (filteredArray.length === 0) {
                return ''; // All items were empty after trim or "Not specified"
            }
            displayValueStr = filteredArray.map(item => Handlebars.Utils.escapeExpression(String(item))).join(', ');
        } else {
            // For other types like numbers, convert to string. Then apply string logic.
            const stringValue = String(value).trim();
            if (stringValue === '') {
                return '';
            }
            const normalizedForCompare = stringValue.replace(/\s+/g, ' ').toLowerCase();
            if (normalizedForCompare === 'not specified') {
                return '';
            }
            displayValueStr = Handlebars.Utils.escapeExpression(stringValue);
        }

        if (displayValueStr === '') {
            return ''; // Final safeguard
        }
        
        const safeLabel = Handlebars.Utils.escapeExpression(label);
        return new Handlebars.SafeString(`<p>${safeLabel}: ${displayValueStr}</p>`);
    },
    eq: function(a, b) {
        return a === b;
    },
    isLength: function(str, options) {
        if (typeof str !== 'string') {
            return false;
        }
        const min = options.hash.min || 0;
        const max = options.hash.max || Infinity;
        return str.length >= min && str.length <= max;
    },
    and: function(...args) {
        // The last argument is the options object, which we don't need here.
        // We just check if all other arguments are truthy.
        return args.slice(0, -1).every(Boolean);
    }
};
