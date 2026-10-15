// ---------- Config ----------
const CATEGORIES = {
  pharmacy: { icon: "💊", label: "Pharmacy",   filter: '["amenity"="pharmacy"]' },
  atm:      { icon: "🏧", label: "ATM",        filter: '["amenity"="atm"]' },
  cafe:     { icon: "☕", label: "Cafe",       filter: '["amenity"="cafe"]' },
  hospital: { icon: "🏥", label: "Hospital",   filter: '["amenity"="hospital"]' },
  print:    { icon: "🖨️", label: "Print shop", filter: '["shop"~"copyshop|stationery"]' },
};
const DEFAULT_LOC = { lat: 12.9346, lon: 77.6063, name: "CHRIST University, Bengaluru" };

// ---------- State ----------
const state = { loc: DEFAULT_LOC, category: "pharmacy", radius: 1500, places: [], showingFavs: false, sortBy: "distance", nameFilter: "" };
let favourites = loadJSON("favourites", []);
let markers = [];
let searchTimer, toastTimer;
let cards = {}, markerById = {};

// ---------- Helpers ----------
// (chips are drawn first so the UI still works even if the map library fails to load)
const $ = (id) => document.getElementById(id);
function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage unavailable */ }
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.remove("opacity-0");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("opacity-0"), 2500);
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

// ---------- Map ----------
if (typeof L === "undefined") {
  renderChips();
  document.getElementById("status").innerHTML =
    '<p class="text-sm p-3 rounded-lg bg-red-50 text-red-700">Map library (Leaflet) failed to load. Check your internet connection and refresh.</p>';
  throw new Error("Leaflet not loaded");
}
const map = L.map("map").setView([state.loc.lat, state.loc.lon], 15);
// ---------- Base layers (no API key needed) ----------
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const esriAttr = "Tiles © Esri";
// OSM's own tile server refuses pages opened from file:// (no Referer), so a local file uses Esri streets instead.
const street = location.protocol === "file:"
  ? L.tileLayer(`${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, attribution: "Tiles © Esri · Place data © OpenStreetMap contributors" })
  : L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" });
const imagery = L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 18, attribution: esriAttr });
const labels = L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 18 });
const topo = L.tileLayer(`${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 18, attribution: esriAttr });
street.addTo(map);
L.control.layers(
  { "Street": street, "Satellite": imagery, "Satellite + labels": L.layerGroup([imagery, labels]), "Terrain": topo },
  null, { position: "topright" }
).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

// ---------- Custom markers ----------
const pinIcon = (emoji) => L.divIcon({
  className: "", iconSize: [38, 46], iconAnchor: [19, 44], popupAnchor: [0, -40],
  html: `<div class="pin-wrap"><div class="pin"><span>${emoji}</span></div></div>`,
});
const youIcon = L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11], html: '<div class="you"><span></span></div>' });
let youMarker = L.marker([state.loc.lat, state.loc.lon], { icon: youIcon, zIndexOffset: 500 }).addTo(map).bindPopup("You are here");
let radiusCircle = L.circle([state.loc.lat, state.loc.lon], {
  radius: state.radius, color: "#7B2CBF", weight: 1.5, dashArray: "6 6", fillColor: "#7B2CBF", fillOpacity: 0.06, interactive: false,
}).addTo(map);

function clearMarkers() { markers.forEach((m) => map.removeLayer(m)); markers = []; }

// ---------- UI states ----------
function setStatus(kind, msg, retry) {
  const box = $("status");
  box.innerHTML = "";
  if (kind === "loading") {
    box.innerHTML = '<div class="flex items-center gap-3 py-4"><div class="spinner"></div><span class="text-sm">Finding places near you…</span></div>';
  } else if (kind === "error" || kind === "empty") {
    const p = document.createElement("p");
    p.className = `text-sm p-3 rounded-xl status-${kind}`;
    p.textContent = msg;
    box.appendChild(p);
    if (retry) {
      const b = document.createElement("button");
      b.textContent = "Try again";
      b.className = "btn mt-2 text-sm";
      b.addEventListener("click", retry);
      box.appendChild(b);
    }
  }
}

// ---------- Chips (event: click) ----------
function renderChips() {
  const wrap = $("chips");
  wrap.innerHTML = "";
  Object.entries(CATEGORIES).forEach(([key, c]) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = `${c.icon} ${c.label}`;
    b.setAttribute("aria-pressed", key === state.category);
    b.addEventListener("click", () => {                       // EVENT 1
      state.category = key; state.showingFavs = false;
      renderChips(); fetchPlaces();
    });
    wrap.appendChild(b);
    const opt = new Option(c.label, key);
    if (![...$("rCat").options].some((o) => o.value === key)) $("rCat").add(opt);
  });
}

// ---------- Fetch: Overpass (JSON) with mirrors + timeout ----------
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
let reqId = 0;
async function overpass(query) {
  let lastErr;
  for (const base of OVERPASS_URLS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(base, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`Overpass responded ${res.status}`);
      return await res.json();
    } catch (e) { lastErr = e; } finally { clearTimeout(timer); }
  }
  throw lastErr;
}
// Backup source: Nominatim category search inside the radius box (same OSM data)
const NOMINATIM_Q = { pharmacy: "pharmacy", atm: "atm", cafe: "cafe", hospital: "hospital", print: "print shop" };
async function nominatimPlaces(lat, lon, radius, category) {
  const dLat = radius / 111320, dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const box = [lon - dLon, lat + dLat, lon + dLon, lat - dLat].join(",");
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=50&extratags=1&bounded=1` +
              `&viewbox=${box}&q=${encodeURIComponent(NOMINATIM_Q[category])}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);
  const data = await res.json();
  return data.map((r) => ({
    id: `${r.osm_type}/${r.osm_id}`,
    name: r.name || r.display_name.split(",")[0] || "Unnamed place",
    lat: parseFloat(r.lat), lon: parseFloat(r.lon),
    hours: r.extratags?.opening_hours || "",
    wheelchair: r.extratags?.wheelchair || "",
  }));
}

function overpassToPlaces(data) {
  return (data.elements || []).map((e) => {
    const plat = e.lat ?? e.center?.lat, plon = e.lon ?? e.center?.lon;
    if (plat == null) return null;
    return {
      id: `${e.type}/${e.id}`, name: e.tags?.name || "Unnamed place",
      lat: plat, lon: plon,
      hours: e.tags?.opening_hours || "", wheelchair: e.tags?.wheelchair || "",
    };
  }).filter(Boolean);
}

async function fetchPlaces() {
  const myReq = ++reqId;
  const { lat, lon } = state.loc;
  const category = state.category;
  radiusCircle.setLatLng([lat, lon]).setRadius(state.radius);
  $("resultsTitle").textContent = `${CATEGORIES[category].label} near you`;
  $("results").innerHTML = "";
  setStatus("loading");
  const query = `[out:json][timeout:25];nwr${CATEGORIES[category].filter}(around:${state.radius},${lat},${lon});out center 60;`;
  let places;
  try {
    try {
      places = overpassToPlaces(await overpass(query));            // main source
    } catch (e1) {
      console.warn("Overpass failed, using Nominatim backup:", e1);
      places = await nominatimPlaces(lat, lon, state.radius, category); // backup source
    }
    if (myReq !== reqId) return; // a newer search has started
    state.places = places
      .map((p) => ({ ...p, category, distance: haversine(lat, lon, p.lat, p.lon) }))
      .filter((p) => p.distance <= state.radius)
      .sort((a, b) => a.distance - b.distance);
    setStatus("none");
    renderResults();
  } catch (err) {
    if (myReq !== reqId) return;
    console.error(err);
    state.places = [];
    renderResults(true);
    setStatus("error", `Couldn't load places (${err.message}). Check your connection or disable ad-block/VPN, then try again.`, fetchPlaces);
  }
}

// ---------- Render results ----------
function selectPlace(id, scroll) {
  Object.values(markerById).forEach((mk) => mk.getElement()?.classList.remove("active"));
  markerById[id]?.getElement()?.classList.add("active");
  Object.values(cards).forEach((c) => c.classList.remove("selected"));
  const c = cards[id];
  if (!c) return;
  c.classList.add("selected");
  if (scroll) c.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderResults(skipEmpty) {
  const list = $("results");
  list.innerHTML = "";
  clearMarkers();
  cards = {}; markerById = {};
  let items = (state.showingFavs ? favourites : state.places)
    .map((p) => ({ ...p, distance: haversine(state.loc.lat, state.loc.lon, p.lat, p.lon) }));
  if (!state.showingFavs) {
    if ($("filterOpen").checked) items = items.filter((p) => p.hours);
    if ($("filterWheel").checked) items = items.filter((p) => p.wheelchair === "yes");
  }
  const q = state.nameFilter.trim().toLowerCase();
  if (q) items = items.filter((p) => p.name.toLowerCase().includes(q));
  items.sort(state.sortBy === "name" ? (a, b) => a.name.localeCompare(b.name) : (a, b) => a.distance - b.distance);

  $("resultsTitle").textContent = state.showingFavs ? "Saved places" : `${CATEGORIES[state.category].label} near you`;
  $("resultCount").textContent = items.length ? `${items.length} place${items.length > 1 ? "s" : ""} found` : "";

  if (!items.length && !skipEmpty) {
    const msg = state.showingFavs
      ? "No saved places yet. Tap ☆ on a result to save it."
      : q ? `Nothing matches "${state.nameFilter.trim()}". Clear the name filter to see all results.`
          : `No ${CATEGORIES[state.category].label.toLowerCase()} found within ${fmtDist(state.radius)}. Try a larger radius or remove filters.`;
    setStatus("empty", msg);
    map.fitBounds(radiusCircle.getBounds());
    return;
  }
  if (items.length) setStatus("none");

  items.forEach((p) => {
    const isFav = favourites.some((f) => f.id === p.id);
    const li = document.createElement("li");
    li.className = "place";
    const info = document.createElement("div");
    const t = document.createElement("p"); t.className = "font-semibold"; t.textContent = `${CATEGORIES[p.category]?.icon || "📍"} ${p.name}`;
    const d = document.createElement("p"); d.className = "text-xs muted";
    d.textContent = `${p.hours || "Hours not listed"}` + (p.wheelchair === "yes" ? " · Wheelchair friendly" : "");
    const dir = document.createElement("a");
    dir.className = "text-xs underline link";
    dir.textContent = "Walking directions";
    dir.target = "_blank"; dir.rel = "noopener";
    dir.href = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${state.loc.lat},${state.loc.lon};${p.lat},${p.lon}`;
    dir.addEventListener("click", (ev) => ev.stopPropagation());
    info.append(t, d, dir);

    const fav = document.createElement("button");
    fav.className = "fav";
    fav.setAttribute("aria-label", isFav ? "Remove from saved" : "Save place");
    fav.textContent = isFav ? "★" : "☆";
    fav.addEventListener("click", (ev) => { ev.stopPropagation(); toggleFav(p); });   // EVENT: favourite
    const side = document.createElement("div");
    side.className = "flex flex-col items-end gap-1";
    const pill = document.createElement("span");
    pill.className = "pill"; pill.textContent = fmtDist(p.distance);
    side.append(pill, fav);
    li.append(info, side);

    const m = L.marker([p.lat, p.lon], { icon: pinIcon(CATEGORIES[p.category]?.icon || "📍") }).addTo(map);
    const pop = document.createElement("div");
    const pb = document.createElement("b"); pb.textContent = p.name;
    const ps = document.createElement("div"); ps.className = "text-xs"; ps.textContent = `${fmtDist(p.distance)} away`;
    pop.append(pb, ps);
    m.bindPopup(pop);
    markers.push(m); markerById[p.id] = m; cards[p.id] = li;
    m.on("click", () => selectPlace(p.id, true));                                     // EVENT: marker click -> card
    li.addEventListener("click", () => { map.setView([p.lat, p.lon], 17); m.openPopup(); selectPlace(p.id); }); // EVENT: card click
    li.addEventListener("mouseenter", () => { m.setZIndexOffset(1000); m.openPopup(); });  // EVENT: hover
    list.appendChild(li);
  });
  if (markers.length) map.flyToBounds(L.featureGroup([youMarker, ...markers]).getBounds().pad(0.15), { duration: 0.8 });
}

function toggleFav(p) {
  const was = favourites.some((f) => f.id === p.id);
  favourites = was ? favourites.filter((f) => f.id !== p.id) : [...favourites, p];
  saveJSON("favourites", favourites);
  toast(was ? `Removed ${p.name} from saved places` : `Saved ${p.name}`);
  renderResults();
}

// ---------- Location: Nominatim search (JSON) ----------
function setLocation(lat, lon, name) {
  state.loc = { lat, lon, name };
  $("locationLabel").textContent = `Searching around: ${name}`;
  youMarker.setLatLng([lat, lon]);
  map.setView([lat, lon], 15);
  state.showingFavs = false;
  fetchPlaces();
}

$("searchInput").addEventListener("input", (e) => {          // EVENT 4 (debounced)
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const box = $("suggestions");
  if (q.length < 3) { box.classList.add("hidden"); return; }
  searchTimer = setTimeout(async () => {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error("Nominatim error");
      const data = await res.json();
      box.innerHTML = "";
      if (!data.length) {
        box.innerHTML = '<li class="p-2 muted">No matching location. Try a nearby landmark.</li>';
      }
      data.forEach((r) => {
        const li = document.createElement("li");
        li.className = "sugg";
        li.textContent = r.display_name;
        li.addEventListener("click", () => {
          box.classList.add("hidden");
          $("searchInput").value = r.display_name.split(",")[0];
          setLocation(parseFloat(r.lat), parseFloat(r.lon), r.display_name.split(",").slice(0, 2).join(","));
        });
        box.appendChild(li);
      });
      box.classList.remove("hidden");
    } catch {
      box.innerHTML = '<li class="p-2" style="color:var(--danger)">Location search failed. Check your connection.</li>';
      box.classList.remove("hidden");
    }
  }, 500);
});

$("locateBtn").addEventListener("click", () => {
  if (!navigator.geolocation) return setStatus("error", "Your browser can't share location. Type an area above instead.");
  setStatus("loading");
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation(pos.coords.latitude, pos.coords.longitude, "your current location"),
    () => setStatus("error", "Location permission denied. Type an area in the search box instead."),
    { timeout: 10000 }
  );
});

$("radius").addEventListener("change", (e) => {              // EVENT 5
  state.radius = Number(e.target.value); fetchPlaces();
});
$("radius").addEventListener("input", (e) => { $("radiusValue").textContent = fmtDist(Number(e.target.value)); });
$("filterOpen").addEventListener("change", () => renderResults());
$("filterWheel").addEventListener("change", () => renderResults());
$("showFavsBtn").addEventListener("click", () => {
  state.showingFavs = !state.showingFavs;
  $("showFavsBtn").textContent = state.showingFavs ? "Back to results" : "Show saved places";
  if (state.showingFavs) renderResults(); else { $("resultsTitle").textContent = `${CATEGORIES[state.category].label} near you`; renderResults(); }
});

// ---------- Report form: validation + feedback ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RULES = {
  rName:  (v) => (v.length < 2 ? "Enter your name (at least 2 characters)." : ""),
  rEmail: (v) => (!EMAIL_RE.test(v) ? "Enter a valid email like name@example.com." : ""),
  rCat:   (v) => (!v ? "Choose a category." : ""),
  rDesc:  (v) => (v.length < 10 ? `Add more detail (${v.length}/10 characters).` : ""),
};
function validateField(id) {
  const val = $(id).value.trim(), msg = RULES[id](val);
  document.querySelector(`.err[data-for="${id}"]`).textContent = msg;
  $(id).classList.toggle("border-red-500", !!msg);
  $(id).classList.toggle("border-green-600", !msg && val !== "");
  return !msg;
}
const validateForm = () => Object.keys(RULES).map(validateField).every(Boolean);
Object.keys(RULES).forEach((id) => {
  $(id).addEventListener("blur", () => validateField(id));                 // EVENT: blur
  $(id).addEventListener("change", () => validateField(id));
  $(id).addEventListener("input", () => {                                  // EVENT: live feedback
    if ($(id).classList.contains("border-red-500")) validateField(id);
  });
});
$("rDesc").addEventListener("input", (e) => {
  const n = e.target.value.trim().length;
  $("descCount").textContent = n >= 10 ? `${n} characters ✓` : `${n}/10 minimum`;
});
$("reportForm").addEventListener("submit", (e) => {
  e.preventDefault();
  $("formMsg").textContent = "";
  if (!validateForm()) { toast("Please fix the highlighted fields"); return; }
  const reports = loadJSON("reports", []);
  reports.push({ name: $("rName").value.trim(), email: $("rEmail").value.trim(), category: $("rCat").value,
                 description: $("rDesc").value.trim(), near: state.loc.name, at: new Date().toISOString() });
  saveJSON("reports", reports);
  $("reportForm").reset();
  Object.keys(RULES).forEach((id) => $(id).classList.remove("border-green-600", "border-red-500"));
  $("descCount").textContent = "0/10 minimum";
  $("formMsg").textContent = "Thanks! Your report is saved. You can also fix the data directly on openstreetmap.org.";
  toast("Report saved");
});

// ---------- Extra interactions ----------
$("sortBy").addEventListener("change", (e) => { state.sortBy = e.target.value; renderResults(); });   // EVENT: sort
$("nameFilter").addEventListener("input", (e) => { state.nameFilter = e.target.value; renderResults(); }); // EVENT: live filter
map.on("click", (e) => {                                                                             // EVENT: map click
  setLocation(e.latlng.lat, e.latlng.lng, `pin (${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)})`);
  toast("Search point moved. Updating results…");
});
document.addEventListener("keydown", (e) => {                                                        // EVENT: keyboard
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
  if (e.key === "/" && !typing) { e.preventDefault(); $("searchInput").focus(); }
  if (e.key === "Escape") { $("suggestions").classList.add("hidden"); document.activeElement.blur(); }
});

// ---------- Theme toggle ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("themeBtn").textContent = t === "dark" ? "☀ Light" : "🌙 Dark";
}
applyTheme(loadJSON("theme", window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
$("themeBtn").addEventListener("click", () => {                                                       // EVENT: theme toggle
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(t); saveJSON("theme", t); toast(`${t === "dark" ? "Dark" : "Light"} theme on`);
});

// ---------- Init ----------
renderChips();
$("locationLabel").textContent = `Searching around: ${state.loc.name}`;
fetchPlaces();
