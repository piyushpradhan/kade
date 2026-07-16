/** Maps plan.json values to the KADE Notion template property names and options. */

const PROPERTIES = {
  title: "Task name",
  status: "Status",
  provider: "Provider",
  model: "Model",
  priority: "Priority",
  project: "Project",
  parentTask: "Parent-task",
  blockedBy: "Blocked By",
  relatedTo: "Related To",
  assigned: "Assigned",
  startedAt: "Started At",
  completedAt: "Completed on",
  exitCode: "Exit Code",
  errorLog: "Error Log",
  tags: "Tags",
};

const PROJECT_PROPERTIES = {
  title: "Project name",
  status: "Status",
  priority: "Priority",
  summary: "Summary",
  tasks: "Tasks",
};

// Must match the live Tasks template exactly. It only has these four.
const STATUS = {
  todo: "Not Started",
  in_progress: "In Progress",
  done: "Done",
  archived: "Archived",
};

const PROJECT_STATUS = {
  backlog: "Backlog",
  planning: "Planning",
  in_progress: "In Progress",
  paused: "Paused",
  done: "Done",
  canceled: "Canceled",
};

const PRIORITY = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

function mapStatus(value) {
  return STATUS[value?.toLowerCase?.()] || value || STATUS.todo;
}

function mapPriority(value) {
  return PRIORITY[value?.toLowerCase?.()] || value || PRIORITY.medium;
}

function mapProjectStatus(value) {
  return PROJECT_STATUS[value?.toLowerCase?.()] || value || PROJECT_STATUS.planning;
}

// Projects Priority only has Low/Medium/High — clamp Urgent down to High.
function mapProjectPriority(value) {
  const p = mapPriority(value);
  return p === PRIORITY.urgent ? PRIORITY.high : p;
}

module.exports = {
  PROPERTIES,
  PROJECT_PROPERTIES,
  STATUS,
  PROJECT_STATUS,
  PRIORITY,
  mapStatus,
  mapPriority,
  mapProjectStatus,
  mapProjectPriority,
};
