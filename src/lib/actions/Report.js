import moment from 'moment';
import _ from 'underscore';
import lodashGet from 'lodash.get';
import Ion from '../Ion';
import {queueRequest, onReconnect} from '../Network';
import IONKEYS from '../../IONKEYS';
import CONFIG from '../../CONFIG';
import * as Pusher from '../Pusher/pusher';
import promiseAllSettled from '../promiseAllSettled';
import ExpensiMark from '../ExpensiMark';
import Notification from '../Notification';
import * as PersonalDetails from './PersonalDetails';

let currentUserEmail;
let currentUserAccountID;
Ion.connect({key: IONKEYS.SESSION, callback: (val) => {
    currentUserEmail = val.email;
    currentUserAccountID = val.accountID;
}});

let currentURL;
Ion.connect({key: IONKEYS.CURRENT_URL, callback: val => currentURL = val});

let personalDetails;

// Use a regex pattern here for an exact match so it doesn't also match "my_personal_details"
Ion.connect({key: `^${IONKEYS.PERSONAL_DETAILS}$`, callback: val => personalDetails = val});

let myPersonalDetails;
Ion.connect({key: IONKEYS.MY_PERSONAL_DETAILS, callback: val => myPersonalDetails = val});

const currentReports = {};
Ion.connect({key: `${IONKEYS.REPORT}_[0-9]+$`, callback: (val, key) => currentReports[key] = val});

const currentReportHistories = {};
Ion.connect({key: `${IONKEYS.REPORT_HISTORY}_[0-9]+$`, callback: (val, key) => currentReportHistories[key] = val});

/**
 * Checks the report to see if there are any unread history items
 *
 * @param {string} accountID
 * @param {object} report
 * @returns {boolean}
 */
function hasUnreadHistoryItems(accountID, report) {
    const usersLastReadActionID = lodashGet(report, ['reportNameValuePairs', `lastReadActionID_${accountID}`]);
    if (!usersLastReadActionID || report.reportActionList.length === 0) {
        return false;
    }

    // Find the most recent sequence number from the report history
    const lastReportAction = _.chain(report.reportActionList)
        .pluck('sequenceNumber')
        .max()
        .value();

    if (!lastReportAction) {
        return false;
    }

    // There are unread items if the last one the user has read is less than the highest sequence number we have
    return usersLastReadActionID < lastReportAction.sequenceNumber;
}

/**
 * Only store the minimal amount of data in Ion that needs to be stored
 * because space is limited
 *
 * @param {object} report
 * @param {number} report.reportID
 * @param {string} report.reportName
 * @param {object} report.reportNameValuePairs
 * @returns {object}
 */
function getSimplifiedReportObject(report) {
    return {
        reportID: report.reportID,
        reportName: report.reportName,
        reportNameValuePairs: report.reportNameValuePairs,
        hasUnread: hasUnreadHistoryItems(currentUserAccountID, report),
    };
}

/**
 * Returns a generated report title based on the participants
 *
 * @param {array} sharedReportList
 * @return {string}
 */
function getChatReportName(sharedReportList) {
    return _.chain(sharedReportList)
        .map(participant => participant.email)
        .filter(participant => participant !== currentUserEmail)
        .map(participant => lodashGet(personalDetails, [participant, 'firstName']) || participant)
        .value()
        .join(', ');
}

/**
 * Fetches chat reports when provided a list of
 * chat report IDs
 *
 * @param {Array} chatList
 * @return {Promise}
 */
function fetchChatReportsByIDs(chatList) {
    let fetchedReports;
    return queueRequest('Get', {
        returnValueList: 'reportStuff',
        reportIDList: chatList.join(','),
        shouldLoadOptionalKeys: true,
    })
        .then(({reports}) => {
            fetchedReports = reports;

            // Build array of all participant emails so we can
            // get the personal details.
            const emails = _.chain(reports)
                .pluck('sharedReportList')
                .reduce((participants, sharedList) => {
                    const emailArray = _.map(sharedList, participant => participant.email);
                    return [...participants, ...emailArray];
                }, [])
                .filter(email => email !== currentUserEmail)
                .unique()
                .value();

            return PersonalDetails.getForEmails(emails.join(','));
        })
        .then(() => {
            // Process the reports and store them in Ion
            const ionPromises = _.map(fetchedReports, (report) => {
                const newReport = getSimplifiedReportObject(report);

                if (lodashGet(report, 'reportNameValuePairs.type') === 'chat') {
                    newReport.reportName = getChatReportName(report.sharedReportList);
                }

                // Merge the data into Ion. Don't use set() here or multiSet() because then that would
                // overwrite any existing data (like if they have unread messages)
                return Ion.merge(`${IONKEYS.REPORT}_${report.reportID}`, newReport);
            });

            return Promise.all(ionPromises);
        });
}

/**
 * Updates a report in the store with a new report action
 *
 * @param {string} reportID
 * @param {object} reportAction
 */
function updateReportWithNewAction(reportID, reportAction) {
    let promise;

    // This is necessary for local development because there will be pusher events from other engineers with
    // different reportIDs. This means that while in development it's not possible to make new chats appear
    // by creating chats then leaving comments in other windows.
    if (!CONFIG.IS_IN_PRODUCTION && !currentReports[`${IONKEYS.REPORT}_${reportID}`]) {
        throw new Error('report does not exist in the store, so ignoring new comments');
    }

    // When handling a realtime update for a chat that does not yet exist in our store we
    // need to fetch it so that we can properly navigate to it. This enables us populate
    // newly created  chats in the LHN without requiring a full refresh of the app.
    if (!currentReports[`${IONKEYS.REPORT}_${reportID}`]) {
        promise = fetchChatReportsByIDs([reportID])
            .then(() => currentReportHistories[`${IONKEYS.REPORT_HISTORY}_${reportID}`]);
    } else {
        // Get the report history and return that to the next chain
        promise = new Promise((resolve) => {
            resolve(currentReportHistories[`${IONKEYS.REPORT_HISTORY}_${reportID}`]);
        });
    }

    // Get the report history and return that to the next chain
    promise

        // Look to see if the report action from pusher already exists or not (it would exist if it's a comment just
        // written by the user). If the action doesn't exist, then update the unread flag on the report so the user
        // knows there is a new comment
        .then((reportHistory) => {
            if (reportHistory && !reportHistory[reportAction.sequenceNumber]) {
                Ion.merge(`${IONKEYS.REPORT}_${reportID}`, {hasUnread: true});
            }
            return reportHistory || {};
        })

        // Put the report action from pusher into the history, it's OK to overwrite it if it already exists
        .then(reportHistory => ({
            ...reportHistory,
            [reportAction.sequenceNumber]: reportAction,
        }))

        // Put the report history back into Ion
        .then(reportHistory => Ion.set(`${IONKEYS.REPORT_HISTORY}_${reportID}`, reportHistory))

        .then(() => {
            // If this comment is from the current user we don't want to parrot whatever they wrote back to them.
            if (reportAction.actorEmail === currentUserEmail) {
                return;
            }

            const currentReportID = Number(lodashGet(currentURL.split('/'), [1], 0));

            // If we are currently viewing this report do not show a notification.
            if (reportID === currentReportID) {
                return;
            }

            Notification.showCommentNotification({
                reportAction,
                onClick: () => {
                    // Navigate to this report onClick
                    Ion.set(IONKEYS.APP_REDIRECT_TO, `/${reportID}`);
                }
            });
        });
}

/**
 * Initialize our pusher subscriptions to listen for new report comments
 */
function subscribeToReportCommentEvents() {
    const pusherChannelName = `private-user-accountID-${currentUserAccountID}`;
    if (Pusher.isSubscribed(pusherChannelName) || Pusher.isAlreadySubscribing(pusherChannelName)) {
        return;
    }

    Pusher.subscribe(pusherChannelName, 'reportComment', (pushJSON) => {
        updateReportWithNewAction(pushJSON.reportID, pushJSON.reportAction);
    });
}

/**
 * Get all chat reports and provide the proper report name
 * by fetching sharedReportList and personalDetails
 *
 * @returns {Promise}
 */
function fetchChatReports() {
    return queueRequest('Get', {returnValueList: 'chatList'})

        // The string cast below is necessary as Get rvl='chatList' may return an int
        .then(({chatList}) => fetchChatReportsByIDs(String(chatList).split(',')));
}

/**
 * Get all of our reports
 *
 * @returns {Promise}
 */
function fetchAll() {
    let fetchedReports;

    // Request each report one at a time to allow individual reports to fail if access to it is prevented by Auth
    const reportFetchPromises = _.map(CONFIG.REPORT_IDS.split(','), reportID => queueRequest('Get', {
        returnValueList: 'reportStuff',
        reportIDList: reportID,
        shouldLoadOptionalKeys: true,
    }));

    // Chat reports need to be fetched separately than the reports hard-coded in the config
    // files. The promise for fetching them is added to the array of promises here so
    // that both types of reports (chat reports and hard-coded reports) are fetched in
    // parallel
    reportFetchPromises.push(fetchChatReports());

    return promiseAllSettled(reportFetchPromises)
        .then(data => fetchedReports = _.compact(_.map(data, (promiseResult) => {
            // Grab the report from the promise result which stores it in the `value` key
            const report = lodashGet(promiseResult, 'value.reports', {});

            // If there is no report found from the promise, return null
            // Otherwise, grab the actual report object from the first index in the values array
            return _.isEmpty(report) ? null : _.values(report)[0];
        })))
        .then(() => Ion.set(IONKEYS.FIRST_REPORT_ID, _.first(_.pluck(fetchedReports, 'reportID')) || 0))
        .then(() => {
            const ionPromises = _.map(fetchedReports, (report) => {
                // Store only the absolute bare minimum of data in Ion because space is limited
                const newReport = getSimplifiedReportObject(report);

                // Merge the data into Ion. Don't use set() here or multiSet() because then that would
                // overwrite any existing data (like if they have unread messages)
                return Ion.merge(`${IONKEYS.REPORT}_${report.reportID}`, newReport);
            });

            return promiseAllSettled(ionPromises);
        })
        .then(() => fetchedReports);
}

/**
 * Get the history of a report
 *
 * @param {string} reportID
 * @returns {Promise}
 */
function fetchHistory(reportID) {
    return queueRequest('Report_GetHistory', {
        reportID,
        offset: 0,
    })
        .then((data) => {
            const indexedData = _.indexBy(data.history, 'sequenceNumber');
            Ion.set(`${IONKEYS.REPORT_HISTORY}_${reportID}`, indexedData);
        });
}

/**
 * Get the chat report ID, and then the history, for a chat report for a specific
 * set of participants
 *
 * @param {string[]} participants
 * @returns {Promise}
 */
function fetchChatReport(participants) {
    let reportID;

    // Get the current users accountID and set it aside in a local variable
    // which is used for checking if there are unread comments
    return queueRequest('CreateChatReport', {
        emailList: participants.join(','),
    })

        // Set aside the reportID in a local variable so it can be accessed in the rest of the chain
        .then(data => reportID = data.reportID)

        // Make a request to get all the information about the report
        .then(() => queueRequest('Get', {
            returnValueList: 'reportStuff',
            reportIDList: reportID,
            shouldLoadOptionalKeys: true,
        }))

        // Put the report object into Ion
        .then((data) => {
            const report = data.reports[reportID];

            // Store only the absolute bare minimum of data in Ion because space is limited
            const newReport = getSimplifiedReportObject(report);
            newReport.reportName = getChatReportName(report.sharedReportList);

            // Merge the data into Ion. Don't use set() here or multiSet() because then that would
            // overwrite any existing data (like if they have unread messages)
            return Ion.merge(`${IONKEYS.REPORT}_${reportID}`, newReport);
        })

        // Return the reportID as the final return value
        .then(() => reportID);
}

/**
 * Add a history item to a report
 *
 * @param {string} reportID
 * @param {string} reportComment
 * @returns {Promise}
 */
function addHistoryItem(reportID, reportComment) {
    const historyKey = `${IONKEYS.REPORT_HISTORY}_${reportID}`;

    // Convert the comment from MD into HTML because that's how it is stored in the database
    const parser = new ExpensiMark();
    const htmlComment = parser.replace(reportComment);
    const reportHistory = currentReportHistories[historyKey];

    // The new sequence number will be one higher than the highest
    let highestSequenceNumber = _.chain(reportHistory)
        .pluck('sequenceNumber')
        .max()
        .value() || 0;
    const newSequenceNumber = highestSequenceNumber + 1;

    // Optimistically add the new comment to the store before waiting to save it to the server
    return Ion.merge(historyKey, {
        [newSequenceNumber]: {
            actionName: 'ADDCOMMENT',
            actorEmail: currentUserEmail,
            person: [
                {
                    style: 'strong',
                    text: myPersonalDetails.displayName || currentUserEmail,
                    type: 'TEXT'
                }
            ],
            automatic: false,
            sequenceNumber: ++highestSequenceNumber,
            avatar: myPersonalDetails.avatarURL,
            timestamp: moment().unix(),
            message: [
                {
                    type: 'COMMENT',
                    html: htmlComment,

                    // Remove HTML from text when applying optimistic offline comment
                    text: htmlComment.replace(/<[^>]*>?/gm, ''),
                }
            ],
            isFirstItem: false,
            isAttachmentPlaceHolder: false,
        }
    })
        .then(() => queueRequest('Report_AddComment', {
            reportID,
            reportComment: htmlComment,
        }));
}

/**
 * Updates the last read action ID on the report. It optimistically makes the change to the store, and then let's the
 * network layer handle the delayed write.
 *
 * @param {string} accountID
 * @param {string} reportID
 * @param {number} sequenceNumber
 * @returns {Promise}
 */
function updateLastReadActionID(accountID, reportID, sequenceNumber) {
    // Mark the report as not having any unread items
    return Ion.merge(`${IONKEYS.REPORT}_${reportID}`, {
        hasUnread: false,
        reportNameValuePairs: {
            [`lastReadActionID_${accountID}`]: sequenceNumber,
        }
    })

        // Update the lastReadActionID on the report optimistically
        .then(() => queueRequest('Report_SetLastReadActionID', {
            accountID,
            reportID,
            sequenceNumber,
        }));
}

// When the app reconnects from being offline, fetch all of the reports and their history
onReconnect(() => {
    fetchAll().then(reports => _.each(reports, report => fetchHistory(report.reportID)));
});

export {
    fetchAll,
    fetchHistory,
    fetchChatReport,
    addHistoryItem,
    updateLastReadActionID,
    subscribeToReportCommentEvents,
};
