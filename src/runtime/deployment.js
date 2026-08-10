import { resolve } from "node:path";
import { validateGenesis } from "../core/genesis.js";
import { readJson } from "./files.js";

const DEPLOYMENT_FIELDS = ["version", "type", "chainId", "transport", "faucetPasswordEnv", "nodes"];
const NODE_FIELDS = ["name", "validator", "url", "listenHost", "port", "passwordEnv"];

function sameFields(value, expected) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function validateDeploymentManifest(deployment, genesis) {
  validateGenesis(genesis);
  if (!sameFields(deployment, DEPLOYMENT_FIELDS)) {
    throw new Error("deployment manifest contains unsupported or missing fields");
  }
  if (deployment.version !== 1 || deployment.type !== "nova-network-deployment") {
    throw new Error("unsupported NOVA deployment manifest");
  }
  if (deployment.chainId !== genesis.chainId) throw new Error("deployment manifest chainId differs from genesis");
  if (deployment.transport !== "private-network-required") {
    throw new Error("deployment manifest does not require private transport");
  }
  if (typeof deployment.faucetPasswordEnv !== "string" || deployment.faucetPasswordEnv.length === 0) {
    throw new Error("deployment manifest is missing the faucet password environment name");
  }
  if (!Array.isArray(deployment.nodes) || deployment.nodes.length !== genesis.validators.length) {
    throw new Error("deployment manifest node count differs from genesis");
  }
  const passwordEnvironments = new Set([deployment.faucetPasswordEnv]);
  for (let index = 0; index < deployment.nodes.length; index += 1) {
    const node = deployment.nodes[index];
    const validator = genesis.validators[index];
    if (!sameFields(node, NODE_FIELDS)) throw new Error(`deployment node${index + 1} contains unsupported or missing fields`);
    if (node.name !== `node${index + 1}`) throw new Error("deployment node order or name is invalid");
    if (node.validator !== validator.address || node.url !== validator.url) {
      throw new Error(`${node.name} deployment identity differs from genesis`);
    }
    if (!Number.isSafeInteger(node.port) || node.port < 1 || node.port > 65535) {
      throw new Error(`${node.name} deployment port is invalid`);
    }
    if (typeof node.listenHost !== "string" || node.listenHost.length === 0) {
      throw new Error(`${node.name} deployment listenHost is invalid`);
    }
    if (typeof node.passwordEnv !== "string" || passwordEnvironments.has(node.passwordEnv)) {
      throw new Error("deployment password environment names must be non-empty and unique");
    }
    passwordEnvironments.add(node.passwordEnv);
  }
  return deployment;
}

export function readDeployment(directory) {
  const root = resolve(directory);
  const genesis = readJson(resolve(root, "genesis.json"));
  const deployment = readJson(resolve(root, "deployment.json"));
  validateDeploymentManifest(deployment, genesis);
  return { root, genesis, deployment };
}
