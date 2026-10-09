// @ts-check
import { module } from "@prisma/composer";
import aicd3BoardService from "./service.mjs";

export default module("aicd3-board", ({ provision }) => {
  provision(aicd3BoardService, { id: "aicd3board" });
});
