/**
 * This worker script is used to send the form values from the "Request Slack Invite" form on
 * the main website (48ix.net) to a predefined Slack channel to handle such requests.
 *
 * The handler expects JSON data in the request body, transforms that data into a
 * Slack webhook, and posts the message to the channel.
 */
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

// Slack webhook URL, installed to global scope via Cloudflare environment variable
const WEBHOOK_URL = SLACK_WEBHOOK_URL;

/**
 * Construct a Slack message.
 * @param {Object} cf Cloudflare `cf` object
 * @param {Headers} headers fetch Headers from inbound event
 * @param {string} contactName Organization Contact Name
 * @param {string} contactEmail Organization Contact Email Address
 * @param {number} timestamp UNIX timestamp
 */
const makeMessage = (cf, headers, contactName, contactEmail, timestamp) => ({
  attachments: [
    {
      fallback: `${contactName} has requested a Slack invite`,
      color: '#47f2ff',
      pretext: 'New Slack Invite Request',
      title: `Slack Invitation Request from ${contactName}`,
      fields: [
        {
          title: 'Contact Name',
          value: contactName,
          short: true,
        },
        {
          title: 'Email Address',
          value: contactEmail,
          short: true,
        },
        {
          title: 'Country',
          value: cf.country,
          short: true,
        },
        {
          title: 'ASN',
          value: `AS${cf.asn}`,
          short: true,
        },
        {
          title: 'Cloudflare Location',
          value: cf.colo,
          short: true,
        },
        {
          title: 'IP',
          value: headers.get('CF-Connecting-IP'),
          short: true,
        },
        {
          title: 'User Agent',
          value: headers.get('User-Agent'),
          short: false,
        },
      ],
      ts: timestamp,
    },
  ],
});

/**
 * Worker request object.
 * @param {Request} request
 */
const handleRequest = async request => {
  // Destructure request body as JSON.
  const { contactName, emailAddr } = await request.json();

  // Construct a Slack message from the input data.
  const message = makeMessage(request.cf || {}, request.headers || {}, contactName, emailAddr);

  // Send the constructed Slack message.
  const slackRes = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=UTF-8' },
    body: JSON.stringify(message),
  });

  // Return Slack's JSON response & status code with CORS headers.
  return new Response(JSON.stringify(slackRes.json()), {
    status: slackRes.status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'content-type': 'application/json;charset=UTF-8',
    },
  });
};
