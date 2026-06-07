import "dotenv/config";
import { startStdio } from "./transports/stdio.js";
import { startHttp } from "./transports/http.js";

const transport = (process.env.BOOKIE_TRANSPORT ?? "stdio").toLowerCase();

if (transport === "http") {
  await startHttp();
} else {
  await startStdio();
}
