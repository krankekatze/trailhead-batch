const config = require('config');

const i18n = new (require('i18n-2'))({
  locales: ['en', 'ja'],
  extension: '.json'
});
i18n.setLocale(config.get('locale'));

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
sendMessageToSlack(i18n.__('Message.Initiated'));

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

connection.login(SALESFORCE_USER_NAME, SALESFORCE_PASSWORD, async (err: any, userInfo: { id: string; organizationId: string; }) => {
  if (err) {
    logger.error(err);
    await sendMessageToSlack(i18n.__('Salesforce.Error.Authentication'), 'danger', i18n.__('Message.Failure'));
    return;
  }

  logger.info(`Access Token: ${connection.accessToken}`);
  logger.info(`Instance URL: ${connection.instanceUrl}`);

  logger.info(`User ID: ${userInfo.id}`);
  logger.info(`Org ID: ${userInfo.organizationId}`);

  let query = 'SELECT Id, Name, Profile_Link__c FROM Trailblazer__c';

  logger.info(`query: ${query}`);

  connection.query(query, async (err: any, result: { totalSize: string; records: any[]; done: string; nextRecordsUrl: string; }) => {
    if (err) {
      logger.error(err);
      await sendMessageToSlack(i18n.__('Salesforce.Error.Query'), 'danger', i18n.__('Message.Failure'));
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
    let trailblazersWithGettingPageError = [];
    let trailblazersWithGettingElementError = [];
    let trailblazersWithScrapingError = [];

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
        try {
          await page.goto(trailblazer.Profile_Link__c, { waitUntil: 'networkidle2' });

          const waitInterval = 3000;
          const repeatCountNumber = config.get('puppeteer.pageLoadWaitTime') / waitInterval;

          let isPageLoaded = false;
          let isElementLoaded = false;

          for (let j = 0; j < repeatCountNumber; j++) {
            await page.waitFor(waitInterval);

            if (await page.$('c-trailhead-rank').then((element: any) => !!element)) {
              isPageLoaded = true;
              const trailheadStatusElement = await page.$('c-trailhead-rank');
              const trailheadStatusString: string = await (await trailheadStatusElement.getProperty('innerText')).jsonValue();
              const trailheadStausArray: string[] = trailheadStatusString.split('\n');
              if (trailheadStausArray.length === 8) {
                isElementLoaded = true;

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
              }

            } else {
              logger.info(`waiting for page to load... ${j}`);
            }

            if (isElementLoaded) {
              break;

            } else if (isPageLoaded) {
              logger.info(`waiting for element to load... ${j}`);
            }
          }

          if (!isPageLoaded) {
            logger.error(i18n.__('Puppeteer.Error.GettingPage'));
            trailblazersWithGettingPageError.push(`${trailblazer.Id}, ${trailblazer.Name}, ${trailblazer.Profile_Link__c}`);

          } else if (!isElementLoaded) {
            logger.error(i18n.__('Puppeteer.Error.GettingElement'));
            trailblazersWithGettingElementError.push(`${trailblazer.Id}, ${trailblazer.Name}, ${trailblazer.Profile_Link__c}`);
          }

        } catch (e) {
          logger.error(i18n.__('Puppeteer.Error.ScrapingData'));
          logger.error(e);
          trailblazersWithScrapingError.push(`${trailblazer.Id}, ${trailblazer.Name}, ${trailblazer.Profile_Link__c}`);

        } finally {
          page.close();
        }
      }

    } catch (e) {
      logger.error(i18n.__('Puppeteer.Error.Crash'));
      logger.error(e);
      await sendMessageToSlack(i18n.__('Puppeteer.Error.Crash'), 'danger', i18n.__('Message.Failure'));
      throw e;

    } finally {
      await browser.close();
      logger.info('browser closed');

      if (trailblazersWithGettingPageError.length > 0) {
        await sendMessageToSlack(i18n.__('Puppeteer.Error.GettingPage') + '\n• ' + trailblazersWithGettingPageError.join('\n• '), 'warning', i18n.__('Message.Failure'));
      }
      if (trailblazersWithGettingElementError.length > 0) {
        await sendMessageToSlack(i18n.__('Puppeteer.Error.GettingElement') + '\n• ' + trailblazersWithGettingElementError.join('\n• '), 'warning', i18n.__('Message.Failure'));
      }
      if (trailblazersWithScrapingError.length > 0) {
        await sendMessageToSlack(i18n.__('Puppeteer.Error.ScrapingData') + '\n• ' + trailblazersWithScrapingError.join('\n• '), 'warning', i18n.__('Message.Failure'));
      }
    }

    if (config.get('salesforce.shouldUpdate')) {
      connection.sobject('Trailblazer__c').update(
        statusArray,
        async (err: any, returnValues: { id: string; success: any; }[]) => {
          if (err) {
            logger.error(i18n.__('Salesforce.Error.Update'));
            logger.error(err);
            await sendMessageToSlack(i18n.__('Salesforce.Error.Update'), 'danger', i18n.__('Message.Failure'));
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
        logger.error(i18n.__('CSV.Error.Preparation'));
        await sendMessageToSlack(i18n.__('CSV.Error.Preparation'), 'danger', i18n.__('Message.Failure'));
        throw err;
      }
      fs.writeFile(`${config.get('file.csvDirectory')}${config.get('file.csvFileName')}.csv`, output, async (err: any) => {
        if (err) {
          logger.error(i18n.__('CSV.Error.Save'));
          await sendMessageToSlack(i18n.__('CSV.Error.Save'), 'danger', i18n.__('Message.Failure'));
          throw err;
        }
        logger.info(`${config.get('file.csvFileName')}.csv saved`);
      });
    });

    await sendMessageToSlack(i18n.__('Message.Processed'), 'good');
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

  connection.query(query, async (err: any, result: { totalSize: string; records: any[]; done: string; nextRecordsUrl: string; }) => {
    if (err) {
      logger.error(err);
      await sendMessageToSlack(i18n.__('Salesforce.Error.Query'), 'danger', i18n.__('Message.Failure'));
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
      await sendMessageToSlack('• ' + messageArray.join('\n• '), '#764FA5', i18n.__('Message.Difference'));
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