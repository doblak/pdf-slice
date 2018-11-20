import {DateTime} from 'luxon';
import logger from "./logger";
import {Config, Employee} from "./config";
import {Vector} from "prelude-ts";
import {Report} from "./report";
import os = require('os');
const fs = require('fs');
const path = require('path');
const qpdf = require('node-qpdf');

const scissors = require('scissors');
const PDFParser = require('pdf2json');
const Table = require('cli-table2');
const readline = require('readline');

const config: Config = require('./../config.json');
const args = process.argv.slice(2);


// a function that extracts  stringified pdf contents
async function collectContents(pdfPath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let pdfParser = new PDFParser();
        pdfParser.on("pdfParser_dataError", (errData: any) => reject(errData.parserError) );
        pdfParser.on("pdfParser_dataReady", (pdfData: any) => {
            //decodeURI replaces %20 with spaces (and similar replacements)
            resolve(decodeURI(JSON.stringify(pdfData)));
        });

        pdfParser.loadPDF(pdfPath);
    });
}

// async function slice(userRedmineUsernameFilter: string | null) {
async function slice(pdfFileName: string) {

    const pdfFolderPath = './pdfs'
    const pdfFilePath = path.join(pdfFolderPath, pdfFileName);
    const pdfFileBaseName = path.parse(pdfFilePath).name;
    logger.info("Loading pdf " + pdfFilePath);

    // get whole PDF length
    const numberOfPages = await scissors(pdfFilePath).getNumPages();
    logger.info("Processing " + numberOfPages + " pages");
    
    const pages = Vector
        .ofIterable(Array(numberOfPages).keys())
        .map(x => x + 1);
    
    // slice by pages
    await Promise.all(
        pages.map(page => {
        return new Promise(function (resolve, reject) {
            const slicedPageFilePath = path.join(pdfFolderPath, pdfFileBaseName + '-' + page.toString() + '.pdf');
            logger.info("Slicing page: " + page);
            scissors(pdfFilePath)
                .pages(page)
                .pdfStream()
                .pipe(fs.createWriteStream(slicedPageFilePath))
                .on('finish', function(){
                    logger.info("Slicing page " + page + " done");
                    resolve();
                })
                .on('error',function(err: any) {
                    logger.error("Failed to slice page " + page)
                    reject(err);
                });
            });
        })
    );
    
    const employees = Vector.ofIterable(config.employees);
    // const  = Vector.empty<PendingEmail>();

    // inspect each of sliced pdfs for keyword
    const processedPages = Vector.ofIterable(await Promise.all<ProcessedPage>(
        pages.map(page => {
            return new Promise<ProcessedPage>(async function (resolve, reject) {
                const slicedPageFilePath = path.join(pdfFolderPath, pdfFileBaseName + '-' + page.toString() + '.pdf');
                logger.info("Inspecting file: " + slicedPageFilePath);
                const contents = await collectContents(slicedPageFilePath);
                // logger.info(contents);
                
                const matches = employees.filter(x => contents.includes(x.name));
    
                if(matches.isEmpty()) {
                    const msg = "ERROR: no matching user for file " + slicedPageFilePath;
                    logger.warn(msg);
                    resolve({
                        pendingEmailOrErrorMessage: msg
                    });
                }
                else if(matches.length() > 1) {
                    const msg = "ERROR: multiple matching users for file " + slicedPageFilePath + '(' + matches.mkString(', ') + ')';
                    logger.error(msg);
                    reject(msg)
                }
                else {
                    const employee = matches.single().getOrThrow();
    
                    const slicedPageWithUserFilePath = path.join(pdfFolderPath, pdfFileBaseName + '-' + employee.name + '.pdf');
                    await qpdf.encrypt(slicedPageFilePath,
                        {
                            keyLength: 256,
                            password: employee.pdfPwd,
                            outputFile: slicedPageWithUserFilePath,
                            restrictions: {
                                print: 'full',
                                useAes: 'y'
                            }
                        });
                    fs.unlinkSync(slicedPageFilePath);

                    resolve({
                        pendingEmailOrErrorMessage: {
                            name: employee.name,
                            email: employee.email || `${employee.name.replace(' ', '.')}@${config.emailDomain}`,
                            subject: config.emailSubject,
                            emailContent: config.emailContent,
                            attachmentName: path.basename(slicedPageWithUserFilePath),
                            attachmentPath: slicedPageWithUserFilePath
                        }
                    });
                }
            })
        })
    ));

    const reportTable = new Table({
        head: ['message', 'user', 'email', 'attachment'],
        colWidths: [40, 25, 35, 60],
        style: {
            compact: true
        },
        wordWrap: true
    });

    reportTable.push(...processedPages
        .map(x => {
            if(isPendingEmail(x.pendingEmailOrErrorMessage)) {
                return ['✓' , x.pendingEmailOrErrorMessage.name, x.pendingEmailOrErrorMessage.email, x.pendingEmailOrErrorMessage.attachmentPath];
            }
            else {
                return [x.pendingEmailOrErrorMessage]
            } 
        })
        .toArray());

    const mailsToSend = processedPages
        .filter(x => isPendingEmail(x.pendingEmailOrErrorMessage))
        .map(x => <PendingEmail>x.pendingEmailOrErrorMessage);

    logger.info(`Successfully sliced and recognized ${mailsToSend.length()} of ${numberOfPages} pages:`);
    logger.info(os.EOL + reportTable.toString());
    

    function askQuestion(query: string) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        return new Promise(resolve => rl.question(query, (ans: string) => {
            rl.close();
            resolve(ans);
        }))
    }


    const ans = await askQuestion("Send mails (y/n)?");
    
    if(ans === 'y') {
        console.info("Sending mails ... ");
        await Promise.all(
            mailsToSend
                .map(mail =>
                    Report.sendMail(mail.email, mail.subject, mail.emailContent, mail.attachmentName, mail.attachmentPath))
        );

        console.info("Mails sent. Done.");
    }
    else {
        console.info("Skipping sending mails (user did not confirm)");
    }

    process.exit(0);
}

interface ProcessedPage {
    pendingEmailOrErrorMessage: PendingEmail | string;
}

interface PendingEmail {
    name: string;
    email: string;
    subject: string;
    emailContent: string;
    attachmentName: string;
    attachmentPath: string;
}

function isPendingEmail(item: PendingEmail | string): item is PendingEmail {
    return (<PendingEmail>item).emailContent !== undefined;
}

if(args.length != 1)
    throw("Run with single argument (pdf name in ./pdfs/ folder to process)");
slice(args[0]);