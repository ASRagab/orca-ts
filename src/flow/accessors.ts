import { currentFlowContext } from "./context.ts";

export const flowContext = currentFlowContext;

export function fs() {
  return currentFlowContext().fs;
}

export function git() {
  return currentFlowContext().git;
}

export function gh() {
  return currentFlowContext().gh;
}

export function linear() {
  return currentFlowContext().linear;
}

export function terminal() {
  return currentFlowContext().terminal;
}

export function command() {
  return currentFlowContext().command;
}

export function llm() {
  return currentFlowContext().llm;
}

export function plan() {
  return currentFlowContext().plan;
}

export function review() {
  return currentFlowContext().review;
}

export function reporter() {
  return currentFlowContext().reporter;
}
