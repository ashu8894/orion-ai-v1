require("dotenv").config();
const OpenAI = require('openai');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { OPENAI_API_KEY, ASSISTANT_ID, SERPAPI_KEY, PERPLEXITY_API_KEY} = process.env;

// + Addition for function calling
const { getJson } = require("serpapi");

// Setup Express
const app = express();
app.use(express.json()); // Middleware to parse JSON bodies
app.use(cors()); // CORS for normal routes

// Set up OpenAI Client
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    defaultHeaders: {
        "OpenAI-Beta": "assistants=v2"
    }
});

// Assistant can be created via API or UI
const assistantId = ASSISTANT_ID;
let pollingInterval;

// + Addition for function calling
// Remember you can declare function on assistant API (during creation) 
//      or directly at GUI

async function getSearchResult(query) {
    console.log('------- CALLING AN EXTERNAL API ----------')
    const json = await getJson({
        engine: "google",
        api_key: SERPAPI_KEY,
        q: query,
        location: "New Delhi, India",
    });

    return json["organic_results"];
}

async function getPerplexityAnswer(query) {
  const url = 'https://api.perplexity.ai/chat/completions';

  const data = {
  model: 'sonar-pro',
  messages: [
    {
      role: 'system',
      content: `Always perform a web search using the latest data sources before answering. 
Never rely on your own memory or training data. Your priority is to fetch and return fresh, real-time information from the web.`
    },
    {
      role: 'user',
      content: query
    }
  ]
};


  try {
    const response = await axios.post(url, data, {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`
      }
    });

    const assistantReply = response.data.choices?.[0]?.message?.content;
    return assistantReply || 'No response from assistant.';
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    return 'Something went wrong.';
  }
}



// Set up a Thread
async function createThread() {
    console.log('Creating a new thread...');
    const thread = await openai.beta.threads.create();
    return thread;
}

async function addMessage(threadId, message) {
    console.log('Adding a new message to thread: ' + threadId);
    const response = await openai.beta.threads.messages.create(
        threadId,
        {
            role: "user",
            content: message
        }
    );
    return response;
}

async function runAssistant(threadId) {
    console.log('Running assistant for thread: ' + threadId)
    const response = await openai.beta.threads.runs.create(
        threadId,
        { 
          assistant_id: assistantId
          // Make sure to not overwrite the original instruction, unless you want to
        }
      );

    return response;
}

async function checkAndHandleRunStatus(res, threadId, runId) {
  let responded = false;

  try {
    while (true) {
      const run = await openai.beta.threads.runs.retrieve(threadId, runId);
      const status = run.status;
      console.log(`Run status: ${status}`);

      if (status === 'queued' || status === 'in_progress') {
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }

      if (status === 'requires_action') {
        const toolCalls = run.required_action.submit_tool_outputs.tool_calls;
        const parsedArgs = JSON.parse(toolCalls[0].function.arguments);

        // Replace "2024" with the current year in the query
        const currentYear = new Date().getFullYear();
        let query = parsedArgs.query;
        if (query.includes("2024")) {
          query = query.replace(/2024/g, currentYear.toString());
        }
        console.log('Function requires query:', query);

        const searchResults = await getPerplexityAnswer(query);
        // const toolOutput = JSON.stringify(searchResults || []);
        console.log(searchResults);

        await openai.beta.threads.runs.submitToolOutputs(threadId, runId, {
          tool_outputs: [
            {
              tool_call_id: toolCalls[0].id,
              output: searchResults,
            },
          ],
        });

        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;

      }

      if (status === 'completed') {
        const messagesList = await openai.beta.threads.messages.list(threadId);
        const lastMessage = messagesList.body.data[0]?.content[0]?.text?.value || "No response";

        if (!responded) {
          responded = true;
          res.json({ message: lastMessage });
        }

        break; // ✅ Stop the loop after responding
      }

      if (status === 'failed' || status === 'cancelled') {
        if (!responded) {
          responded = true;
          res.status(500).json({ error: `Run ${status}` });
        }

        break; // ✅ Stop the loop after responding
      }
    }
  } catch (err) {
    console.error('Error during run status polling:', err);
    if (!responded) {
      res.status(500).json({ error: 'Unexpected server error' });
    }
  }
}





//=========================================================
//============== ROUTE SERVER =============================
//=========================================================

// Open a new thread
app.get('/thread', (req, res) => {
    createThread().then(thread => {
        res.json({ threadId: thread.id });
    });
})

app.post('/message', async (req, res) => {
  const { message, threadId } = req.body;

  const finalThreadId = threadId || "thread_QFPJ2QeyhEkfpG7W3d6PsOpq";

  try {
    await addMessage(finalThreadId, message);
    const run = await runAssistant(finalThreadId);
    await checkAndHandleRunStatus(res, finalThreadId, run.id);
  } catch (err) {
    console.error('Top-level error:', err);
    res.status(500).json({ error: 'Failed to handle assistant flow' });
  }
});


// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
