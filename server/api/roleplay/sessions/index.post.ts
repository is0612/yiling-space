import { roleplayApi } from "../../../utils/roleplay-api";

export default defineEventHandler(event => roleplayApi(event, "postSession"));
