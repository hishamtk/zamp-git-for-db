import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one Postgres; parallel files race on gitdb.branches / main.
    fileParallelism: false,
  },
});
