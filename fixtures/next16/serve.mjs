// Serves the adapter suite's routes with this directory's Next.js.
import { serve } from "@fixtures/next-app";
import next from "next";

await serve(next, import.meta.dirname, process.argv[2]);
