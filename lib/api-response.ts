export async function apiResult<T=any>(response:Response,fallback='Request failed.'):Promise<T>{
  const text=await response.text();
  let data;
  try{data=JSON.parse(text);}catch{
    throw Error(`${fallback} (HTTP ${response.status}; invalid server response.)`);
  }
  if(!response.ok)throw Error(typeof data?.error==='string'?data.error:`${fallback} (HTTP ${response.status})`);
  if(!data||typeof data!=='object'||!('result' in data))throw Error(`${fallback} Invalid server response.`);
  return data.result as T;
}
