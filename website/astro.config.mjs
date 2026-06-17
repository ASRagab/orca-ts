import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://ASRagab.github.io",
  base: "/orca-ts",
  integrations: [
    starlight({
      title: "Orca TypeScript",
      description: "Deterministic coding-agent flows, loops, and saved automation in TypeScript.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/ASRagab/orca-ts"
        }
      ],
      editLink: {
        baseUrl: "https://github.com/ASRagab/orca-ts/edit/main/website/"
      },
      sidebar: [
        {
          label: "Start Here",
          items: [
            { label: "Overview", slug: "start/overview" },
            { label: "Quickstart", slug: "start/quickstart" },
            { label: "Concepts", slug: "start/concepts" }
          ]
        },
        {
          label: "Install",
          items: [
            { label: "Standalone Binary", slug: "install/binary" },
            { label: "Typed Authoring", slug: "install/typed-authoring" },
            { label: "Source Checkout", slug: "install/source-checkout" },
            { label: "Agent Skills", slug: "install/agent-skills" }
          ]
        },
        {
          label: "Guides",
          items: [
            { label: "First Flow", slug: "guides/first-flow" },
            { label: "Saved Workflow", slug: "guides/saved-workflow" },
            { label: "Backend Setup", slug: "guides/backend-setup" },
            { label: "Loops", slug: "guides/loops" },
            { label: "Served Loops", slug: "guides/served-loops" },
            { label: "Monitoring And Recovery", slug: "guides/monitoring-recovery" }
          ]
        },
        {
          label: "Reference",
          items: [
            { label: "CLI", slug: "reference/cli" },
            { label: "Public API", slug: "reference/api" },
            { label: "Backend Matrix", slug: "reference/backends" },
            { label: "Loop API", slug: "reference/loop-api" },
            { label: "State Stores", slug: "reference/state-stores" },
            { label: "Agent Skills", slug: "reference/agent-skills" },
            { label: "Examples", slug: "reference/examples" },
            { label: "Distribution And Release", slug: "reference/distribution-release" }
          ]
        },
        {
          label: "Troubleshooting",
          items: [
            { label: "Install", slug: "troubleshooting/install" },
            { label: "Typecheck", slug: "troubleshooting/typecheck" },
            { label: "Backend Auth", slug: "troubleshooting/backend-auth" },
            { label: "Loops", slug: "troubleshooting/loops" },
            { label: "Workflow Execution", slug: "troubleshooting/workflow-execution" },
            { label: "Docs Site", slug: "troubleshooting/docs-site" }
          ]
        }
      ]
    })
  ]
});
