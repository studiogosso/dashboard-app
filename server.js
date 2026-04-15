// __workspace_env_loader__
try { require('fs').readFileSync(require('path').join(require('os').homedir(),'projects/workspace/.env'),'utf8').split('\n').forEach(l=>{const m=l.match(/^([A-Z_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'').trim();}); } catch(e){}
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3460;
const NOTION_API_KEY = `${process.env.NOTION_API_KEY}`;
const ALL_DB_ID = "175269e1-5c23-4274-b9b6-e9226a178531";
const TAG_DB_ID = "1c781666-f256-46d5-ba6b-98ea40454d2b";
const NOTION_VERSION = "2022-06-28";

// --- Notion API helpers ---

async function notionRequest(endpoint, method = "GET", body = null) {
  const url = `https://api.notion.com/v1${endpoint}`;
  const headers = {
    Authorization: `Bearer ${NOTION_API_KEY}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const resp = await fetch(url, options);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Notion API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function queryDatabase(dbId, filter, sorts, pageSize = 100) {
  const body = {};
  if (filter) body.filter = filter;
  if (sorts) body.sorts = sorts;
  if (pageSize) body.page_size = pageSize;
  return notionRequest(`/databases/${dbId}/query`, "POST", body);
}

async function getBlocks(pageId) {
  return notionRequest(`/blocks/${pageId}/children?page_size=100`);
}

function getTitle(page) {
  const titleProp =
    page.properties.Name || page.properties.title || page.properties.Title;
  if (!titleProp) return "(無題)";
  const arr = titleProp.title || titleProp.rich_text || [];
  return arr.map((t) => t.plain_text).join("") || "(無題)";
}

function getPageUrl(page) {
  return page.url || `https://notion.so/${page.id.replace(/-/g, "")}`;
}

function getMultiSelectTags(page) {
  const tags = page.properties.Tags || page.properties.tags;
  if (!tags) return [];
  if (tags.type === "multi_select") return tags.multi_select.map((t) => t.name);
  if (tags.type === "relation") return tags.relation.map((r) => r.id);
  return [];
}

// --- API handlers ---

async function handleToday(req, res) {
  try {
    // Search for latest "Today's ToDo" page
    const result = await queryDatabase(
      ALL_DB_ID,
      {
        property: "Name",
        title: { contains: "Today's ToDo" },
      },
      [{ property: "Created time", direction: "descending" }],
      1
    );

    if (!result.results || result.results.length === 0) {
      return jsonResponse(res, { found: false, items: [], url: null });
    }

    const page = result.results[0];
    const pageId = page.id;
    const pageUrl = getPageUrl(page);
    const title = getTitle(page);

    // Get blocks (to_do items)
    const blocks = await getBlocks(pageId);
    const todos = [];
    for (const block of blocks.results) {
      if (block.type === "to_do") {
        const text = block.to_do.rich_text.map((t) => t.plain_text).join("");
        todos.push({
          text,
          checked: block.to_do.checked,
          id: block.id,
        });
      }
    }

    const done = todos.filter((t) => t.checked).length;
    const total = todos.length;

    jsonResponse(res, {
      found: true,
      title,
      url: pageUrl,
      items: todos,
      done,
      total,
      progress: total > 0 ? Math.round((done / total) * 100) : 0,
    });
  } catch (e) {
    console.error("Error in /api/today:", e.message);
    jsonResponse(res, { error: e.message }, 500);
  }
}

async function handleInbox(req, res) {
  try {
    // Items with no tags (empty Tags property)
    const noTagResult = await queryDatabase(
      ALL_DB_ID,
      {
        property: "Tags",
        relation: { is_empty: true },
      },
      [{ property: "Created time", direction: "descending" }],
      50
    );

    // Also try to find items tagged with INBOX
    // First, find the INBOX tag ID from Tag DB
    let inboxItems = [];
    try {
      const inboxTagResult = await queryDatabase(
        TAG_DB_ID,
        {
          property: "Name",
          title: { equals: "INBOX" },
        },
        null,
        1
      );
      if (inboxTagResult.results && inboxTagResult.results.length > 0) {
        const inboxTagId = inboxTagResult.results[0].id;
        const inboxResult = await queryDatabase(
          ALL_DB_ID,
          {
            property: "Tags",
            relation: { contains: inboxTagId },
          },
          [{ property: "Created time", direction: "descending" }],
          50
        );
        inboxItems = inboxResult.results || [];
      }
    } catch (e) {
      console.log("INBOX tag lookup failed:", e.message);
    }

    // Merge and deduplicate
    const seen = new Set();
    const allItems = [];
    for (const page of [...(noTagResult.results || []), ...inboxItems]) {
      if (!seen.has(page.id)) {
        seen.add(page.id);
        allItems.push({
          id: page.id,
          title: getTitle(page),
          url: getPageUrl(page),
          created: page.created_time,
        });
      }
    }

    jsonResponse(res, {
      count: allItems.length,
      items: allItems.slice(0, 30),
    });
  } catch (e) {
    console.error("Error in /api/inbox:", e.message);
    jsonResponse(res, { error: e.message }, 500);
  }
}

async function handleProjects(req, res) {
  try {
    const projectConfigs = [
      {
        name: "アニメ企画",
        emoji: "🎬",
        tagNames: [".Work", ".Project", ".AnimePitch"],
      },
      {
        name: "レイヴンポータル",
        emoji: "🎮",
        tagNames: [".Work", ".Project", ".RavenPortal"],
      },
      {
        name: "投資",
        emoji: "💰",
        tagNames: [".money diary", ".Investment"],
      },
    ];

    // Resolve tag names to IDs from Tag DB
    const tagDbResult = await queryDatabase(TAG_DB_ID, undefined, null, 100);
    const tagMap = {};
    for (const page of tagDbResult.results || []) {
      const name = getTitle(page);
      tagMap[name] = page.id;
    }

    const projects = [];
    for (const config of projectConfigs) {
      // Build AND filter: all tags must be present
      const tagIds = config.tagNames
        .map((n) => tagMap[n])
        .filter(Boolean);

      if (tagIds.length === 0) {
        projects.push({
          name: config.name,
          emoji: config.emoji,
          items: [],
          count: 0,
        });
        continue;
      }

      const andFilter = tagIds.map((id) => ({
        property: "Tags",
        relation: { contains: id },
      }));

      const result = await queryDatabase(
        ALL_DB_ID,
        { and: andFilter },
        [{ property: "Last edited time", direction: "descending" }],
        10
      );

      const items = (result.results || []).map((page) => ({
        id: page.id,
        title: getTitle(page),
        url: getPageUrl(page),
        lastEdited: page.last_edited_time,
      }));

      projects.push({
        name: config.name,
        emoji: config.emoji,
        items,
        count: items.length,
      });
    }

    jsonResponse(res, { projects });
  } catch (e) {
    console.error("Error in /api/projects:", e.message);
    jsonResponse(res, { error: e.message }, 500);
  }
}

async function handleRecent(req, res) {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = await queryDatabase(
      ALL_DB_ID,
      {
        timestamp: "last_edited_time",
        last_edited_time: { after: since },
      },
      [{ property: "Last edited time", direction: "descending" }],
      20
    );

    const items = (result.results || []).map((page) => ({
      id: page.id,
      title: getTitle(page),
      url: getPageUrl(page),
      lastEdited: page.last_edited_time,
    }));

    jsonResponse(res, { count: items.length, items });
  } catch (e) {
    console.error("Error in /api/recent:", e.message);
    jsonResponse(res, { error: e.message }, 500);
  }
}

// --- Server ---

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  console.log(`${new Date().toLocaleTimeString()} ${req.method} ${pathname}`);

  if (pathname === "/" || pathname === "/index.html") {
    const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } else if (pathname === "/api/today") {
    await handleToday(req, res);
  } else if (pathname === "/api/inbox") {
    await handleInbox(req, res);
  } else if (pathname === "/api/projects") {
    await handleProjects(req, res);
  } else if (pathname === "/api/recent") {
    await handleRecent(req, res);
  } else if (pathname === "/api/auto-tag") {
    // Proxy to tag manager if available
    try {
      const tagResp = await fetch("http://localhost:3457/api/auto-tag", {
        method: "POST",
      });
      const data = await tagResp.json();
      jsonResponse(res, data);
    } catch (e) {
      jsonResponse(res, { error: "タグ管理サーバーに接続できません: " + e.message }, 502);
    }
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard server running at http://localhost:${PORT}`);
});
