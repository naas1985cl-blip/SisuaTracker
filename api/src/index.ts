/**
 * Function App entrypoint (Azure Functions v4 programming model).
 * Importing each module runs its `app.timer(...)` / `app.http(...)`
 * registration as a side effect. `main` in package.json points here.
 */
import './functions/syncWeekly';
import './functions/getDashboard';
import './functions/getRevenue';
import './functions/getExceptions';
import './functions/getWeekOverWeek';
