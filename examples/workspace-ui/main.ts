import { App } from "@modelcontextprotocol/ext-apps";
import { createMcpAppFetch } from "@nia-teams/mcp-sdk/apps/client";
const app = new App({ name: "Reports", version: "1.0.0" });
const fetchApi = createMcpAppFetch({ app, apiToolName: "reports_api" });
// The first call connects via the official ui/initialize handshake.
async function main() {
  try {
    const response = await fetchApi("/api/reports?limit=20");
    document.querySelector("#reports")!.textContent = JSON.stringify(
      await response.json(),
      null,
      2,
    );
  } catch {
    document.querySelector("#reports")!.textContent = "Unable to load reports";
  }
}
void main();
