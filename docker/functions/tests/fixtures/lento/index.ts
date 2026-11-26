Deno.serve(async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return Response.json({ lento: true });
});
