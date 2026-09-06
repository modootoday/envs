import { config } from "./loader/config.js";

export const result = config();

if (result.error) throw result.error;
