export {
  ProjectDatabaseService,
  ProjectDatabaseAdmin,
  ProjectDatabaseEnvironment,
  ProjectDatabaseQa,
  ProjectDatabasePreview,
} from "./worker-service.js";

export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
