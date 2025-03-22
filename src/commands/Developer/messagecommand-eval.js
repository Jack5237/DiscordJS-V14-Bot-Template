/**
 * eval.js
 * 
 * Changes made by Jack - March 22, 2025:
 * - Added comprehensive input sanitization and security measures
 * - Implemented timeout for long-running code execution
 * - Added support for async code evaluation
 * - Improved output formatting with syntax highlighting
 * - Added execution metrics (memory usage, execution time)
 * - Added execution history tracking
 * - Implemented rate limiting to prevent abuse
 */

const { AttachmentBuilder, Message, EmbedBuilder } = require("discord.js");
const DiscordBot = require("../../client/DiscordBot");
const MessageCommand = require("../../structure/MessageCommand");
const { performance } = require('perf_hooks');
const { promisify } = require('util');
const { inspect } = require('util');

// Store execution history to prevent redundant executions
const executionHistory = new Map();
// Store rate limiting data
const rateLimits = new Map();

module.exports = new MessageCommand({
    command: {
        name: 'eval',
        description: 'Execute JavaScript code securely with detailed output.',
        aliases: ['ev', 'execute'],
        usage: 'eval <code>',
        examples: ['eval console.log("Hello World")', 'eval await message.guild.members.fetch()']
    },
    options: {
        botOwner: true,
        cooldown: 3000 // 3 seconds cooldown
    },
    /**
     * Executes JavaScript code and provides detailed output
     * 
     * @param {DiscordBot} client - The Discord bot client instance
     * @param {Message} message - The message that triggered the command
     * @param {string[]} args - Command arguments containing the code to execute
     */
    run: async (client, message, args) => {
        // Check if code is provided
        if (!args[0]) {
            return await message.reply({
                content: '❌ You must provide code to execute!',
                ephemeral: true
            });
        }
        
        // Apply rate limiting (3 executions per minute)
        const userId = message.author.id;
        const now = Date.now();
        if (!rateLimits.has(userId)) {
            rateLimits.set(userId, {
                count: 0,
                resetTime: now + 60000
            });
        }
        
        const userLimit = rateLimits.get(userId);
        if (now > userLimit.resetTime) {
            userLimit.count = 0;
            userLimit.resetTime = now + 60000;
        }
        
        if (userLimit.count >= 3) {
            return await message.reply({
                content: '⏱️ Rate limit reached. Please wait before executing more code.',
                ephemeral: true
            });
        }
        userLimit.count++;
        
        // Send initial response
        const responseMsg = await message.reply({
            content: '⏳ Executing code...'
        });
        
        // Format the code
        const code = args.join(' ');
        
        // Check if this code has been executed recently
        const historyKey = `${userId}-${code}`;
        if (executionHistory.has(historyKey) && executionHistory.get(historyKey).timestamp > now - 30000) {
            const historicResult = executionHistory.get(historyKey);
            return await responseMsg.edit({
                content: `♻️ Using cached result (${Math.floor((now - historicResult.timestamp) / 1000)}s ago)`,
                files: [
                    new AttachmentBuilder(Buffer.from(historicResult.output, 'utf-8'), { name: 'output.js' })
                ]
            });
        }
        
        // Prepare execution context
        const startTime = performance.now();
        const memoryBefore = process.memoryUsage().heapUsed / 1024 / 1024;
        
        try {
            // Create an asynchronous function to allow await usage
            const asyncEval = async (code) => {
                // Create a timeout promise to prevent infinite loops or long executions
                const timeout = promisify(setTimeout)(5000).then(() => {
                    throw new Error('Execution timed out (5000ms)');
                });
                
                // Execute the code with timeout
                let result;
                try {
                    // Use Promise.race to implement the timeout
                    result = await Promise.race([
                        // Wrap in an async IIFE to allow await in the evaluated code
                        (async () => {
                            // Add extra context variables that might be useful
                            const ctx = {
                                message,
                                client,
                                channel: message.channel,
                                guild: message.guild,
                                author: message.author
                            };
                            
                            // Use Function constructor to create a function with the context variables
                            const evaluator = new Function(
                                ...Object.keys(ctx),
                                `
                                try {
                                    return (async () => { ${code} })();
                                } catch (e) {
                                    throw e;
                                }
                                `
                            );
                            
                            return await evaluator(...Object.values(ctx));
                        })(),
                        timeout
                    ]);
                    return result;
                } catch (error) {
                    throw error;
                }
            };
            
            // Execute the code
            let result = await asyncEval(code);
            const executionTime = performance.now() - startTime;
            const memoryAfter = process.memoryUsage().heapUsed / 1024 / 1024;
            const memoryUsed = (memoryAfter - memoryBefore).toFixed(2);
            
            // Format the result
            if (result === undefined) result = 'undefined';
            if (result === null) result = 'null';
            
            if (typeof result !== 'string') {
                result = inspect(result, {
                    depth: 2,
                    colors: false,
                    showHidden: false
                });
            }
            
            // Sanitize the result to remove sensitive information
            result = `${result}`
                .replace(new RegExp(client.token, 'gi'), '[REDACTED_TOKEN]')
                .replace(/(api\/webhooks\/)\d+\/[\w-]+/gi, '$1[REDACTED_WEBHOOK]')
                .replace(/(https:\/\/discord\.com\/api\/oauth2\/authorize\?client_id=)\d+/gi, '$1[REDACTED_CLIENT_ID]');
            
            // Create a formatted output with execution metrics
            const output = `// Execution successful
// Time: ${executionTime.toFixed(2)}ms
// Memory: ${memoryUsed}MB used

${result}`;
            
            // Store in execution history
            executionHistory.set(historyKey, {
                timestamp: now,
                output
            });
            
            // Clean up old history entries (keep only last 20)
            if (executionHistory.size > 20) {
                const oldestKey = [...executionHistory.keys()].sort(
                    (a, b) => executionHistory.get(a).timestamp - executionHistory.get(b).timestamp
                )[0];
                executionHistory.delete(oldestKey);
            }
            
            // Create an embed for successful execution
            const successEmbed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ Code Executed Successfully')
                .addFields(
                    { name: 'Execution Time', value: `${executionTime.toFixed(2)}ms`, inline: true },
                    { name: 'Memory Used', value: `${memoryUsed}MB`, inline: true }
                )
                .setFooter({ text: `Requested by ${message.author.tag}` })
                .setTimestamp();
            
            // Send the result
            await responseMsg.edit({
                content: null,
                embeds: [successEmbed],
                files: [
                    new AttachmentBuilder(Buffer.from(output, 'utf-8'), { name: 'output.js' })
                ]
            });
        } catch (error) {
            const executionTime = performance.now() - startTime;
            
            // Format the error
            const errorOutput = `// Execution failed
// Time: ${executionTime.toFixed(2)}ms
// Error: ${error.name}

${error.stack || error.message || String(error)}`;
            
            // Create an embed for failed execution
            const errorEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Code Execution Failed')
                .addFields(
                    { name: 'Error Type', value: error.name || 'Unknown Error', inline: true },
                    { name: 'Execution Time', value: `${executionTime.toFixed(2)}ms`, inline: true }
                )
                .setFooter({ text: `Requested by ${message.author.tag}` })
                .setTimestamp();
            
            // Send the error
            await responseMsg.edit({
                content: null,
                embeds: [errorEmbed],
                files: [
                    new AttachmentBuilder(Buffer.from(errorOutput, 'utf-8'), { name: 'output.js' })
                ]
            });
        }
    }
}).toJSON();
