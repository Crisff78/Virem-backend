const fs = require('fs');
const path = require('path');

class SystemLogger {
  constructor() {
    this.logs = [];
    this.maxLogs = 50;
    this.logFile = path.join(__dirname, '../system_runtime.log');
    
    // Clear log file on startup
    try {
      fs.writeFileSync(this.logFile, `[SYSTEM] Logger initialized at ${new Date().toISOString()}\n`);
    } catch (e) {
      console.error("Could not create log file", e);
    }
  }

  add(message, type = 'INFO') {
    const timestamp = new Date().toLocaleTimeString();
    const logLine = `[${timestamp}] [${type}] ${message}`;
    
    this.logs.unshift(logLine);
    if (this.logs.length > this.maxLogs) {
      this.logs.pop();
    }

    // Also write to file for persistence if needed
    try {
      fs.appendFileSync(this.logFile, logLine + '\n');
    } catch (e) {}
    
    // Also print to console so developer sees it in terminal too
    if (type === 'ERROR') {
      console.error(logLine);
    } else {
      console.log(logLine);
    }
  }

  getLogs() {
    return this.logs;
  }
}

const sysLogger = new SystemLogger();

module.exports = sysLogger;
