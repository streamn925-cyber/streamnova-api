// vidsrc.js
const cheerio = require('cheerio');
const { decrypt } = require('./helpers/decoder');

let BASEDOM = "https://whisperingauroras.com";

async function fetchWithTimeout(url, options = {}) {
    const { timeout = 8000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
}

async function serversLoad(html) {
  const $ = cheerio.load(html);
  const servers = [];
  const title = $("title").text() ?? "";
  const base = $("iframe").attr("src") ?? "";
  try {
      BASEDOM = new URL(base.startsWith("//") ? "https:" + base : base).origin ?? BASEDOM;
  } catch (e) { }

  $(".serversList .server").each((index, element) => {
    const server = $(element);
    servers.push({ name: server.text().trim(), dataHash: server.attr("data-hash") ?? null });
  });
  return { servers, title };
}

async function PRORCPhandler(prorcp) {
  try {
      const prorcpFetch = await fetchWithTimeout(`${BASEDOM}/prorcp/${prorcp}`);
      const prorcpResponse = await prorcpFetch.text();
      const scripts = prorcpResponse.match(/<script\s+src="\/([^"]*\.js)\?\_=([^"]*)"><\/script>/gm);
      if (!scripts) return null;
      
      const script = (scripts[scripts.length - 1].includes("cpt.js"))
        ? scripts[scripts.length - 2].replace(/.*src="\/([^"]*\.js)\?\_=([^"]*)".*/, "$1?_=$2")
        : scripts[scripts.length - 1].replace(/.*src="\/([^"]*\.js)\?\_=([^"]*)".*/, "$1?_=$2");
        
      const jsFileReq = await fetchWithTimeout(`${BASEDOM}/${script}`, {
        headers: { "accept": "*/*", "Referer": `${BASEDOM}/` },
        method: "GET",
      });
      const jsCode = await jsFileReq.text();
      const decryptRegex = /{}\}window\[([^"]+)\("([^"]+)"\)/;
      const decryptMatches = jsCode.match(decryptRegex);
      
      const $ = cheerio.load(prorcpResponse);
      if (!decryptMatches || decryptMatches?.length < 3) return null;
      
      const id = decrypt(decryptMatches[2].toString().trim(), decryptMatches[1].toString().trim());
      if (!id) return null;
      
      const data = $("#" + id);
      if (!data || data.length === 0) return null;

      const result = await decrypt(await data.text(), decryptMatches[2].toString().trim());
      return result;
  } catch (e) {
      console.error("PRORCP Error:", e.message);
      return null;
  }
}

async function rcpGrabber(html) {
  const regex = /src:\s*'([^']*)'/;
  const match = html.match(regex);
  if (!match) return null;
  return { metadata: { image: "" }, data: match[1] };
}

async function tmdbScrape(tmdbId, type, season, episode) {
  try {
      const url = (type === "movie")
        ? `https://vidsrc.net/embed/${type}?tmdb=${tmdbId}`
        : `https://vidsrc.net/embed/${type}?tmdb=${tmdbId}&season=${season}&episode=${episode}`;
        
      const embed = await fetchWithTimeout(url, {
          headers: { 
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
          }
      });
      const embedResp = await embed.text();
      const { servers, title } = await serversLoad(embedResp);
      
      const rcpFetchPromises = servers.map(element => 
          fetchWithTimeout(`${BASEDOM}/rcp/${element.dataHash}`)
              .then(r => r.text())
              .catch(() => null)
      );
      
      const rcpResponses = await Promise.all(rcpFetchPromises);
      const prosrcrcp = await Promise.all(rcpResponses.map(async (response) => response ? rcpGrabber(response) : null));

      const apiResponse = [];
      for (const item of prosrcrcp) {
        if (!item || !item.data) continue;
        if (item.data.substring(0, 8) === "/prorcp/") {
          const streamUrl = await PRORCPhandler(item.data.replace("/prorcp/", ""));
          if (streamUrl) {
              apiResponse.push({
                name: title || "VidSrc Server",
                mediaId: tmdbId,
                stream: streamUrl,
                referer: BASEDOM,
              });
          }
        }
      }
      return apiResponse;
  } catch (error) {
      console.error("Scraper Error:", error.message);
      return [];
  }
}

module.exports = tmdbScrape;
