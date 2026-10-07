import path from "path"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"

// offline-fork: /curl dumps the last LLM request of the session as a reusable curl script.
// Served by the raw /offline/dump-request route in packages/opencode/src/offline/request-capture.ts.

type Result = { success: true; scriptPath: string; jsonPath: string } | { success: false; error: string }

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "session.curl",
        title: "Dump last request as curl",
        slashName: "curl",
        category: "Debug",
        namespace: "palette",
        async run() {
          api.ui.dialog.clear()
          const sessionID = "params" in api.route.current ? api.route.current.params?.sessionID : undefined
          if (typeof sessionID !== "string") {
            api.ui.toast({ variant: "warning", message: "Open a session to dump its last request" })
            return
          }
          const session = api.state.session.get(sessionID)
          const parent = session?.parentID ? api.state.session.get(session.parentID) : undefined
          // The route is outside the generated SDK surface; reuse the SDK's transport for it.
          const response = await api.client["client"].post<{ 200: Result }>({
            url: "/offline/dump-request",
            body: { sessionID, slug: session?.slug, parentSlug: parent?.slug },
            headers: { "Content-Type": "application/json" },
          })
          if (response.data?.success) {
            api.ui.toast({
              variant: "success",
              message: `Run: ${response.data.scriptPath} ${path.basename(response.data.jsonPath)}`,
              duration: 5000,
            })
            return
          }
          api.ui.toast({
            variant: "warning",
            message: response.data?.error ?? "No HTTP request has been captured for this session",
            duration: 5000,
          })
        },
      },
    ],
  })
}

export default {
  id: "internal:offline-curl",
  tui,
} satisfies BuiltinTuiPlugin
