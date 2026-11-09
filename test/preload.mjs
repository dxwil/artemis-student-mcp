import { installMock } from "./mock-artemis.js";

const scenario = process.env.ARTEMIS_MOCK_SCENARIO;
if (scenario) {
  installMock(scenario, process.env);
}
