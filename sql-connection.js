import sql from "mssql";

export function parseDotNetConnectionString(connectionString) {
  const map = {};
  connectionString
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const idx = part.indexOf("=");
      if (idx <= 0) return;
      const key = part.slice(0, idx).trim().toLowerCase();
      map[key] = part.slice(idx + 1).trim();
    });

  const serverRaw = map.server || map["data source"];
  const database = map.database || map["initial catalog"];
  const user = map["user id"] || map.uid || map.user;
  const password = map.password || map.pwd;

  if (!serverRaw || !database || !user || !password) {
    throw new Error(
      "Invalid SQL connection string. Required: Server, Database, User Id, Password."
    );
  }

  const [serverHost, portRaw] = serverRaw.split(",");
  const port = Number(portRaw);
  const timeoutSeconds = Number(map["connection timeout"] || "30");
  const encrypt = String(map.encrypt || "false").toLowerCase() === "true";
  const trustServerCertificate =
    String(map["trustservercertificate"] || "false").toLowerCase() === "true";

  const config = {
    user,
    password,
    server: serverHost.trim(),
    database,
    connectionTimeout: timeoutSeconds * 1000,
    requestTimeout: timeoutSeconds * 1000,
    options: {
      encrypt,
      trustServerCertificate,
      enableArithAbort: true,
    },
  };

  if (Number.isFinite(port)) {
    config.port = port;
  }

  return config;
}

export async function connectSql(connectionString) {
  const config = parseDotNetConnectionString(connectionString);
  return sql.connect(config);
}

export { sql };
