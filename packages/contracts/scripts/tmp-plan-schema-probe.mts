import { z } from "zod";
import { UiPlanSchema } from "../src/ui-plan.js";

const schema = z.toJSONSchema(UiPlanSchema, { target: "draft-7" });
const json = JSON.stringify(schema);
console.log("OK bytes=", json.length);
console.log(json.slice(0, 400));
