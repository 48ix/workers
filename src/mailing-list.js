/**
 * This worker script is used to handle mailing list subscription requests from the main website (48ix.net).
 *
 * The worker is attached to patch 48ix.net/mailing-list and looks for the following URL query parameters:
 *
 * @param {string} action Must be 'add' or 'subscribe'
 * @param {string} emailAddr Contact's email address
 * @param {string} listName Contact list. Most likely 'public-announce'
 *
 * If the action is 'add', the contact is created & left unsubscribed by default. Upon successful contact
 * creation, the contact is sent a confirmation email based on a predefined MailJet template. When the user
 * clicks the confirmation button, another request is made to the worker with an action of 'subscribe'.
 * With the 'subscribe' action, the contact is changed to a subscribed state.
 */
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

// MailJet Basic Authentication variables, consumed via environment variables in scope via Cloudflare.
const MJ_USER = MAILJET_USER || null;
const MJ_PASS = MAILJET_PASS || null;

// MailJet URL Endpoints
const MJ_ADD_CONTACT = 'https://api.mailjet.com/v3/REST/listrecipient';
const MJ_CONTACT = 'https://api.mailjet.com/v3/REST/contact';
const MJ_CONTACTS_LIST = 'https://api.mailjet.com/v3/REST/contactslist';
const MJ_TEMPLATE = 'https://api.mailjet.com/v3/REST/template';
const MJ_LIST_RECIPIENT = 'https://api.mailjet.com/v3/REST/listrecipient';
const MJ_SEND = 'https://api.mailjet.com/v3.1/send';

// Slack webhook variable, consumed via environment variables in scope via Cloudflare.
const SLACK_URL = SLACK_WEBHOOK_URL;

/**
 * Generate a Slack message.
 * @param {string} emailAddr Contact Email Address
 * @param {string} listName Contact List Name
 * @param {string=} errorMsg Error Message, if any
 */
const makeMessage = (emailAddr, listName, errorMsg) => {
  const payload = {
    attachments: [
      {
        fallback: `${emailAddr} has subscribed to ${listName}`,
        color: '#f4dc87',
        pretext: 'New mailing list subscription',
        title: `${emailAddr} has subscribed to ${listName}`,
      },
    ],
  };
  if (errorMsg) {
    payload.attachments[0].color = '#f25979';
    payload.attachments[0].fields = [{ title: 'Error', value: errorMsg, short: false }];
  }
  return payload;
};

/**
 * Send a message to Slack when a user subscribes, or when an error occurs.
 * @param {string} emailAddr Contact Email Address
 * @param {string} listName Contact List Name
 * @param {string=} errorMsg Error Message, if any
 */
const notifySlack = async (emailAddr, listName, errorMsg) => {
  try {
    const response = await fetch(SLACK_URL, {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(makeMessage(emailAddr, listName, errorMsg)),
    });
    return response;
  } catch (err) {
    console.error(err);
  }
};

/**
 * Custom Error Class.
 * @param {...*} args Arguments
 */
class MailingListError extends Error {
  constructor(...args) {
    super(...args);
    this.name = 'MailingListError';
  }
}

/**
 * Fetch API wrapper for easier & simpler http handling in other functions.
 */
class Client {
  constructor() {
    this.headers = new Headers({
      // MailJet Basic Authentication
      Authorization: `Basic ${btoa(`${MJ_USER}:${MJ_PASS}`)}`,
      Accept: 'application/json',
    });
  }

  /**
   * Parse an error. Tries to parse JSON first, then text, with fallback to generic status text.
   * @param {Response} response Fetch Response
   */
  async clientError(response) {
    // Declare & assign fallback error response
    let detail = response.statusText;
    let errors = [];

    /**
     * Because response.json() and response.text() "consume" an IO reader of response.body, the
     * response needs to be cloned in order to run both functions.
     * */
    const textResponse = response.clone();

    try {
      const jsonResponse = await response.json();

      // MailJet specific JSON error properties
      detail = `${jsonResponse.ErrorCode}: ${jsonResponse.ErrorMessage}`;
    } catch (err) {
      errors.push(err);
    }
    // If reading the response as JSON fails, try to read it as plain text.
    if (!detail) {
      try {
        detail = await textResponse.text();
      } catch (err) {
        errors.push(err);
      }
    }
    /**
     * If reading the response as plain text fails or is empty, fall back a generic error.
     * Log all errors thus far to console.
     * */
    if (!detail) {
      detail = 'General Error';
      errors.length !== 0 && errors.map(err => console.warn(err));
    }
    return detail;
  }
  /**
   * HTTP GET handler.
   * @param {string} url
   */
  async get(url) {
    // Ensure the the URL is encoded.
    const encodedUrl = encodeURI(url);

    const response = await fetch(encodedUrl, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      const error = await this.clientError(response);
      throw new MailingListError(error);
    }
    return response;
  }
  /**
   * HTTP POST handler
   * @param {string} url
   * @param {?Object} data Data to POST as JSON
   */
  async post(url, data) {
    this.headers.append('Content-Type', 'application/json');
    let cfg = {
      method: 'POST',
      headers: this.headers,
    };

    // Only send a request body if data is passed.
    if (typeof data !== 'undefined') {
      cfg.body = JSON.stringify(data);
    }

    const response = await fetch(url, cfg);

    if (!response.ok) {
      const error = await this.clientError(response);
      throw new MailingListError(error);
    }
    return response;
  }
  /**
   * HTTP PUT handler
   * @param {string} url
   * @param {?Object} data Data to PUT as JSON
   */
  async put(url, data) {
    this.headers.append('Content-Type', 'application/json');
    let cfg = {
      method: 'PUT',
      headers: this.headers,
    };

    // Only send a request body if data is passed.
    if (typeof data !== 'undefined') {
      cfg.body = JSON.stringify(data);
    }

    const response = await fetch(url, cfg);

    if (!response.ok) {
      const error = await this.clientError(response);
      throw new MailingListError(error);
    }
    return response;
  }
}

// Initialize the fetch wrapper
const Fetch = new Client();

/**
 * Create a new contact in MailJet with email address `emailAddr`
 * @param {string} emailAddr Email Address
 * @return {boolean} `true` if contact was added, `false` if not
 */
const addContact = async emailAddr => {
  let added = false;
  try {
    const response = await Fetch.post(MJ_CONTACT, { Email: emailAddr });
    if (response.status === 201) {
      added = true;
    }
  } catch (err) {
    console.warn(err);
  }
  return added;
};

/**
 * Get array of all MailJet contact lists.
 * @return {Object[]} Collected & 'cleaned' contact lists
 */
const getAllContactLists = async () => {
  let contactLists = [];
  try {
    const response = await Fetch.get(MJ_CONTACTS_LIST);
    const data = await response.json();

    // Filter MailJet's stupid property syntax to something less stupid
    data.Data.map(l => {
      contactLists.push({
        id: l.ID,
        name: l.Name,
        subscribers: l.SubscriberCount,
      });
    });
  } catch (err) {
    console.warn(err);
  }
  return contactLists;
};

/**
 * Get contact list details.
 * @param {number} listId Contact List ID
 * @return {Object} Collected & 'cleaned' contact list details
 */
const getListDetails = async listId => {
  let listDetails = {};
  try {
    const response = await Fetch.get(`${MJ_CONTACTS_LIST}/${listId}`);
    const details = await response.json();

    // Filter MailJet's stupid property syntax from the first (only) object to something less stupid
    listDetails = {
      id: details.Data[0].ID,
      name: details.Data[0].Name,
      subscribers: details.Data[0].SubscriberCount,
    };
  } catch (err) {
    console.warn(err);
  }
  return listDetails;
};

/**
 * Get contact lists for which emailAddr is a member.
 * @param {string} emailAddr Email Address
 * @return {Object[]} Collected & 'cleaned' contact lists
 */
const getContactLists = async emailAddr => {
  let contactDetails = [];
  try {
    const response = await Fetch.get(`${MJ_CONTACT}/${emailAddr}/getcontactslists`);
    const details = await response.json();

    // Filter MailJet's stupid property syntax to something less stupid
    details.Data.map(list => {
      contactDetails.push({
        id: list.ListID,
        subscribed: !list.IsUnsub,
      });
    });
  } catch (err) {
    console.warn(err);
  }
  return contactDetails;
};

/**
 * Add contact with email address emailAddr to list listId.
 * @param {number} listId Contact List ID
 * @param {string} emailAddr Email Address
 * @return {Object} List membership, contact ID, error if present
 */
const addContactToList = async (listId, emailAddr) => {
  let addedToList = false;
  let contactId = 0;
  let error;
  try {
    const response = await Fetch.post(MJ_ADD_CONTACT, {
      IsUnsubscribed: true,
      ContactAlt: emailAddr,
      ListID: listId,
    });
    if (response.ok) {
      const data = await response.json();
      addedToList = true;
      contactId = data.Data[0].ID;
    }
  } catch (err) {
    console.warn(err);
    error = err;
  }
  return { addedToList, contactId, error };
};

/**
 * Get details for contact with email address emailAddr.
 * @param {string} emailAddr Email Address
 * @return {Object} Boolean of contact existence state, contact ID if contact exists
 */
const getContact = async emailAddr => {
  let [id, exists] = [0, false];
  try {
    const response = await Fetch.get(`${MJ_CONTACT}/${emailAddr}`);
    if (response.status === 200) {
      exists = true;
      const data = await response.json();
      id = data.Data[0].ID;
    }
  } catch (err) {
    console.warn(err);
  }
  return { id, exists };
};

/**
 * Get the Recipient ID for contact with id contactId on list listId.
 * @param {number} contactId Contact ID Number
 * @param {number} listId Contact List ID Number
 * @return {number} Recipient ID Number
 */
const getRecipient = async (contactId, listId) => {
  try {
    const response = await Fetch.get(MJ_LIST_RECIPIENT);
    const data = await response.json();

    // Filter the response to just contacts that match `contactId` and lists that match `listId`
    const recipient = data.Data.filter(r => r.ContactID === contactId && r.ListID === listId);

    // If no contacts match the filter, throw an error.
    if (recipient.length === 0) {
      throw new Error('Contact not found.');
    }
    // Return the recipient ID
    return recipient[0].ID;
  } catch (err) {
    console.warn(err);
  }
};

/**
 * Subscribe contact with ID contactId to list with ID listId.
 * @param {number} contactId Contact ID Number
 * @param {number} listId Contact List ID Number
 * @return {Object} Boolean of subscription state, error in present
 */
const subscribeContact = async (contactId, listId) => {
  let subscribed = false;
  let error;
  const recipientId = await getRecipient(contactId, listId);
  try {
    const response = await Fetch.put(`${MJ_LIST_RECIPIENT}/${recipientId}`, {
      IsUnsubscribed: false,
    });

    // MailJet returns a 304 response if the contact is already subscribed.
    if (response.ok || response.status === 304) {
      subscribed = true;
    }
  } catch (err) {
    console.warn(err);
    error = err;
  }
  return { subscribed, error };
};

/**
 * Get array of all email templates.
 * @return {Object[]} Collected & 'cleaned' email templates
 */
const getTemplates = async () => {
  let templates = [];
  try {
    const response = await Fetch.get(MJ_TEMPLATE);
    if (response.status === 200) {
      const data = await response.json();

      // Filter MailJet's stupid property syntax to something less stupid
      templates = data.Data.map(t => ({ id: t.ID, name: t.Name }));
    }
  } catch (err) {
    console.error(err);
  }
  return templates;
};

/**
 * Send and email to contact with email address emailAddr, from contact list listName, with template templateId.
 * @param {string} emailAddr Email Address
 * @param {number} templateId Template ID Number
 * @param {string} listName Contact List Name
 * @return {Object} Boolean of email send state, error if present
 */
const sendEmail = async (emailAddr, templateId, listName) => {
  let sentEmail = false;
  let error;
  try {
    const response = await Fetch.post(MJ_SEND, {
      Messages: [
        {
          From: {
            Email: `${listName}@48ix.net`,
            Name: '48 IX',
          },
          To: [
            {
              Email: emailAddr,
            },
          ],
          Subject: `Confirm your subscription to ${listName} mailing list`,
          TemplateID: templateId,
          TemplateLanguage: true,
          Variables: {
            LIST_NAME: listName,
          },
        },
      ],
    });

    if (response.ok) {
      sentEmail = true;
    }
  } catch (err) {
    console.error(err);
    error = err.message;
  }
  return { sentEmail, error };
};

/**
 * Parse & decode query parameters from URL string.
 * @param {string} url URL
 * @return {Object} Parsed URL params
 */
const parseUrl = url => {
  let params = {};
  try {
    const urlObj = new URL(url);

    const queryString = urlObj.search.slice(1).split('&');
    queryString.forEach(item => {
      const decodedItem = decodeURIComponent(item);
      const kv = decodedItem.split('=');
      if (kv[0]) {
        params[kv[0]] = kv[1] || true;
      }
    });
  } catch (err) {
    console.error(err);
  }
  return params;
};

/**
 * Worker request handler.
 * @param {Request} request
 * @return {Response}
 */
const handleRequest = async request => {
  // Parse required values from URL query parameters
  const { action, emailAddr, listName } = parseUrl(request.url);

  // Declare & define fallback message & status
  let response = `An error occurred while attempting to add '${emailAddr}' to list '${listName}'`;
  let status = 500;

  const headers = new Headers({ 'Content-Type': 'application/json' });

  // Ensure the required parameters are defined
  [action, emailAddr, listName].map(i => {
    if (typeof i === 'undefined') {
      return new Response(JSON.stringify({ message: 'Unable to parse request.' }), {
        status,
        headers,
      });
    }
  });

  // Declare & define default state variables
  let alreadySubscribed = false;
  let contactExists = false;
  let onList = false;

  // Get List Details by Name
  let listDetails = await getAllContactLists();
  [listDetails] = listDetails.filter(l => l.name === listName);

  // Get template for confirmation email based on `listName`
  const emailTemplates = await getTemplates();
  let [emailTemplate] = emailTemplates.filter(t => t.name === `${listName}-confirmation`);

  if (typeof emailTemplate === 'undefined') {
    return new Response(
      JSON.stringify({
        message: `Error sending confirmation email to '${emailAddr}' for list '${listName}'`,
      }),
      { status: 500 },
    );
  }

  // Find out if the contact has already been DEFINED (not necessarily subscribed or associated with a list)
  const { id: contactId, exists } = await getContact(emailAddr);
  if (exists) {
    contactExists = true;

    // Get array of all contact lists with which the email address is associated
    const contactLists = await getContactLists(emailAddr);
    let [contactList] = contactLists.filter(l => listDetails.id === l.id);

    if (typeof contactList !== 'undefined') {
      onList = true;

      if (contactList.subscribed) {
        alreadySubscribed = true;
      }
    } else {
      // If the contact is already added to MailJet, add it to the contact list `listName`
      const { addedToList, error } = await addContactToList(listDetails.id, emailAddr);

      if (addedToList) {
        onList = true;
      }
    }
  } else {
    // If the contact has not been added previously, create it (in an unsubscribed state).
    const contactAdded = await addContact(emailAddr);

    if (contactAdded) {
      // Once the contact is added to MailJet, add it to the contact list `listName`
      const { addedToList, error } = await addContactToList(listDetails.id, emailAddr);

      if (addedToList) {
        onList = true;
      }
      contactExists = true;

      // If an error occurred while adding the contact to the contact list, return it
      if (typeof error !== 'undefined') {
        return new Response(
          JSON.stringify({
            message: `An error occurred while adding ${emailAddr} to list ${listName}: ${error.message}`,
          }),
          { status: 500 },
        );
      }
    }
  }
  if (onList && alreadySubscribed) {
    /**
     * If the contact is a member of the contact list, and is in a subscribed state,
     * and the action is 'add', don't proceed, and return an error.
     *
     * Note: the 'add' action should only ever happen when a contact enters their email address
     * on the 48ix.net 'Subscribe' component. This is primarily for error handling/ensuring contacts
     * aren't over-emailed.
     */
    if (action === 'add') {
      return new Response(
        JSON.stringify({
          message: `${emailAddr} is already subscribed to contact list '${listName}'`,
        }),
        { status: 409, headers },
      );
    } else if (action === 'subscribe') {
      /**
       * If the contact is a member of the contact list, and is in a subscribed state,
       * and the action is 'subscribe', base64 encode the list name and the contact's email address
       * and redirect the user to the subscription success page.
       *
       * Note: the 'subscribe' action should only ever happen when a contact clicks the 'Confirm' button
       * from the confirmation email.
       */
      const encodedInfo = btoa(encodeURIComponent(`emailAddr=${emailAddr}&listName=${listName}`));
      return Response.redirect(`https://48ix.net/subscribe?${encodedInfo}`, 301);
    }
  }
  if (onList && !alreadySubscribed) {
    /**
     * If the user is on the contact list but is not subscribed, and the action is 'add',
     * send a subscription confirmation email.
     */

    if (action === 'add') {
      const { sentEmail: confirmationSent, error: confirmationError } = await sendEmail(
        emailAddr,
        emailTemplate.id,
        listName,
      );
      // If an error occurred while sending the confirmation email, set it as the JSON response message.
      if (confirmationError) {
        response = confirmationError;
        status = 500;
      }
      // If the confirmation was successful, set the JSON response message & status code to success.
      else if (confirmationSent) {
        response = `A confirmation email has been sent to '${emailAddr}'`;
        status = 200;
      }
    } else if (action === 'subscribe') {
      /**
       * If the user is on the contact list but is not subscribed, and the action is 'subscribe',
       * subscribe the user to the contact list.
       */
      const { subscribed, error } = await subscribeContact(contactId, listDetails.id);

      // base64 encode & URL encode the email address & list name
      let encodedInfo = btoa(encodeURIComponent(`emailAddr=${emailAddr}&listName=${listName}`));

      // If the contact was successfully subscribed, redirect the user to the subscription success page.
      if (subscribed) {
        // Send a Slack notification of a successful subscription.
        await notifySlack(emailAddr, listName);

        return Response.redirect(`https://48ix.net/subscribe?${encodedInfo}`, 301);
      }
      // If an error occurred while subscribing the contact, redirect the user to the subscription failure page.
      else {
        if (typeof error !== 'undefined') {
          // base64 encode & URL encode the email address & list name
          encodedInfo = btoa(
            encodeURIComponent(
              `emailAddr=${emailAddr}&listName=${listName}&error=${error.message}`,
            ),
          );
        }
        // Send a slack notification of a failed subscription.
        await notifySlack(emailAddr, listName, error.message);

        return Response.redirect(`https://48ix.net/subscribe/failure?${encodedInfo}`, 301);
      }
    }
  }
  // Return the final JSON response, to be consumed by the Subscribe component to present a message to the user.
  return new Response(JSON.stringify({ message: response }), {
    status,
    headers,
  });
};
