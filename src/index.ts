const config = require('config');
const winston = require('winston');
require('winston-daily-rotate-file');

const transportRotation = new (winston.transports.DailyRotateFile)({
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  filename: '%DATE%.log',
  dirname: config.get('file.logDirectory'),
  maxSize: '20m',
  maxFiles: '30d',
  auditFile: 'audit.json'
});

const format = winston.format;
const logger = winston.createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.simple(),
    format.printf((info: { timestamp: any; level: any; message: any; }) => `[${info.timestamp}] ${info.level} ${info.message}`)
  ),
  transports: [
    transportRotation,
    new winston.transports.Console({ level: 'debug' }),
  ]
});

logger.info('====================');

const requestPromise = require('request-promise');
sendMessageToSlack('Initiated.');

const fs = require('fs');
const stringify = require('csv-stringify');
const puppeteer = require('puppeteer');

const jsforce = require('jsforce');
const connection = new jsforce.Connection({
  // you can change loginUrl to connect to sandbox or prerelease env.
  // loginUrl : 'https://test.salesforce.com'
});

const SALESFORCE_USER_NAME = config.get('salesforce.userName');
const SALESFORCE_PASSWORD = config.get('salesforce.password');

connection.login(SALESFORCE_USER_NAME, SALESFORCE_PASSWORD, async function (err: any, userInfo: { id: string; organizationId: string; }) {
  if (err) {
    logger.error(err);
    await sendMessageToSlack('Failure: Salesforce: Authentication', 'danger');
    return;
  }

  logger.info(`Access Token: ${connection.accessToken}`);
  logger.info(`Instance URL: ${connection.instanceUrl}`);

  logger.info(`User ID: ${userInfo.id}`);
  logger.info(`Org ID: ${userInfo.organizationId}`);

  let query = 'SELECT Id, Name, Profile_Link__c FROM Trailblazer__c';

  logger.info(`query: ${query}`);

  connection.query(query, async function (err: any, result: { totalSize: string; records: any[]; done: string; nextRecordsUrl: string; }) {
    if (err) {
      logger.error(err);
      await sendMessageToSlack('Failure: Salesforce: Query', 'danger');
      return;
    }
    logger.info(`total: ${result.totalSize}`);
    logger.info(`done?: ${result.done}`);

    if (!result.done) {
      logger.info(`next records URL: ${result.nextRecordsUrl}`);
    }

    refreshTrailblazers(result.records);
  });
});


async function refreshTrailblazers(trailblazers: { Id: string, Name: string, Profile_Link__c: string; }[]) {
  logger.info(`trailblazers length: ${trailblazers.length}`);

  await (async () => {
    let statusArray: { Id: string; Name: any; Badges__c: number; Points__c: number; Trails__c: number; }[] = [];

    const browser = await puppeteer.launch();
    try {
      let i = 1;
      for (let trailblazer of trailblazers) {
        // for of -> sequential operation
        logger.info('----------');
        logger.info(`progress: ${i} / ${trailblazers.length}`);
        i++;

        logger.info(`Id: ${trailblazer.Id}`);
        logger.info(`URL: ${trailblazer.Profile_Link__c}`);

        const page = await browser.newPage();
        await page.goto(trailblazer.Profile_Link__c, { waitUntil: 'networkidle2' });
        await page.waitFor(config.get('puppeteer.pageLoadWaitTime'));

        const trailheadStatusElement = await page.$('c-trailhead-rank');
        if (trailheadStatusElement === null) {
          logger.error('Failure: Get a page');
          logger.info('skipped.');
          await sendMessageToSlack(`Failure: Get a page: ${trailblazer.Id}, ${trailblazer.Name}, ${trailblazer.Profile_Link__c}`, 'warning');
          continue;
        }

        const trailheadStatusString: string = await (await trailheadStatusElement.getProperty('innerText')).jsonValue();
        const trailheadStausArray: string[] = trailheadStatusString.split('\n');
        if (trailheadStausArray.length !== 8) {
          logger.error('Failure: Get element');
          logger.info('skipped.');
          await sendMessageToSlack(`Failure: Get element: ${trailblazer.Id}, ${trailblazer.Name}, ${trailblazer.Profile_Link__c}`, 'warning');
          continue;
        }

        const nameElement = await page.$('h1');

        let data = {
          Id: trailblazer.Id,
          Name: await (await nameElement.getProperty('innerText')).jsonValue(),
          Badges__c: parseInt(trailheadStausArray[1].replace(',', ''), 10),
          Points__c: parseInt(trailheadStausArray[3].replace(',', ''), 10),
          Trails__c: parseInt(trailheadStausArray[5].replace(',', ''), 10)
        };
        logger.info(JSON.stringify(data));
        statusArray.push(data);

        page.close();
      }

    } catch (e) {
      logger.error('Failure: Puppeteer');
      logger.error(e);
      await sendMessageToSlack('Failure: Puppeteer', 'danger');
      throw e;

    } finally {
      await browser.close();
      logger.info('browser closed');
    }

    if (config.get('salesforce.shouldUpdate')) {
      connection.sobject('Trailblazer__c').update(
        statusArray,
        async function (err: any, returnValues: { id: string; success: any; }[]) {
          if (err) {
            logger.error('Failure: Salesforce: Update');
            logger.error(err);
            await sendMessageToSlack('Failure: Salesforce: Update', 'danger');
            return;
          }
          for (let value of returnValues) {
            if (value.success) {
              logger.info(`Updated Successfully: ${value.id}`);
            }
          }
          if (config.get('salesforce.shouldExportHistory')) {
            await exportHistoryFromSalesforce(5);
          }
        }
      );
    }

    stringify(statusArray, { header: true }, async (err: any, output: any) => {
      if (err) {
        logger.error('Failure: CSV: 1');
        await sendMessageToSlack('Failure: CSV: 1', 'danger');
        throw err;
      }
      fs.writeFile(`${config.get('file.csvDirectory')}${config.get('file.csvFileName')}.csv`, output, async (err: any) => {
        if (err) {
          logger.error('Failure: CSV: 2');
          await sendMessageToSlack('Failure: CSV: 2', 'danger');
          throw err;
        }
        logger.info(`${config.get('file.csvFileName')}.csv saved`);
      });
    });

    await sendMessageToSlack('Processed.', 'good');
  })();
}


async function exportHistoryFromSalesforce(minutesAgo: number) {
  let createdDate = new Date();
  createdDate.setMinutes(createdDate.getMinutes() - minutesAgo);

  let query = 'SELECT Parent.Name, OldValue, NewValue, CreatedDate '
    + 'FROM TrailBlazer__History '
    + `WHERE Field = 'Badges__c' AND CreatedDate >= ${createdDate.toISOString()} `
    + 'ORDER BY CreatedDate DESC';

  logger.info(`query: ${query}`);

  connection.query(query, async function (err: any, result: { totalSize: string; records: any[]; done: string; nextRecordsUrl: string; }) {
    if (err) {
      logger.error(err);
      await sendMessageToSlack('Failure: Salesforce: Query', 'danger');
      return;
    }
    logger.info(`total: ${result.totalSize}`);
    logger.info(`done?: ${result.done}`);

    if (!result.done) {
      logger.info(`next records URL: ${result.nextRecordsUrl}`);
    }

    let messageArray = [];
    for (let history of result.records) {
      messageArray.push(`${history.Parent.Name} : ${history.OldValue} -> ${history.NewValue}`);
    }
    if (messageArray.length > 0) {
      await sendMessageToSlack('• ' + messageArray.join('\n• '), '#764FA5', 'Difference');
    }
  });
}


async function sendMessageToSlack(message: string, color = '', title = '') {
  if (!config.get('slack.shouldSendMessage')) {
    return;
  }

  const response = await requestPromise({
    uri: 'https://slack.com/api/chat.postMessage',
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'charset': 'utf-8'
    },
    form: {
      token: config.get('slack.token'),
      channel: config.get('slack.channelId'),
      username: config.get('slack.userName'),
      attachments: JSON.stringify([{
        title: title,
        text: message,
        color: color
      }])
    },
    json: true
  });

  logger.info(`Slack response: ${JSON.stringify(response)}`);
}