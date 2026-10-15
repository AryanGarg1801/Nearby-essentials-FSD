# NearbyEssentials

A focused web app built on OpenStreetMap data that helps newcomers and students find essential services (pharmacy, ATM, cafe, hospital, print shop) near them, sorted nearest first.

## Problem
OpenStreetMap's website relies on name-based search, so people who don't know local names can't browse nearby services by category or distance. NearbyEssentials fixes this with category chips, distance-sorted cards and simple filters.

## Features
- One-tap category chips (Pharmacy, ATM, Cafe, Hospital, Print shop)
- Results sorted by distance, with a radius slider
- Location search (Nominatim) and "Use my location"
- Filters: has opening hours, wheelchair friendly
- Saved places (localStorage)
- "Report a missing or wrong place" form with validation
- Loading, empty and error states with retry

## Tech
HTML5 semantic layout, Tailwind CSS (CDN), vanilla JavaScript, Leaflet, Fetch API with Nominatim and Overpass (JSON).

## Setup
1. Clone the repo: `git clone <your-repo-url>`
2. Open `index.html` in a browser, or run `npx serve .`
3. Allow location access, or type an area in the search box.

## Project structure
```
index.html   page structure and Tailwind layout
script.js    events, fetch, validation, states
README.md
screenshots/
```

## Testing summary
| Test | Expected | Result |
|---|---|---|
| Click "Pharmacy" chip | Distance-sorted list and markers | |
| Invalid email in form | Red inline error | |
| Offline mode | Error message with retry | |
| Rural location | Empty-state message | |
| Location permission denied | Fallback message | |

## Limitations
- Depends on OSM data completeness; opening hours are often missing
- Overpass API rate limits can cause temporary failures
- Report form saves to localStorage only (no backend)

## AI usage declaration
(Write truthfully what you used AI for and what you wrote and tested yourself.)
